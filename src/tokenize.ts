/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

export interface TokenHandler {
  handleToken(type: JsonTokenType.Boolean, value: boolean): void;
  handleToken(type: JsonTokenType.Number, value: number): void;
  handleToken(type: JsonTokenType.StringMiddle, value: string): void;
  handleToken(type: JsonTokenType, value: undefined): void;
}

/**
 * Read tokens from an async iterable of strings and forward them to the given
 * {@link TokenHandler}. The handler is invoked synchronously as tokens are
 * recognized. Throws if the input is not valid JSON, including if it has
 * trailing content.
 */
export function tokenize(stream: AsyncIterable<string>, handler: TokenHandler) {
  return new Tokenizer(stream, handler);
}

const enum State {
  ExpectingValue,
  InString,
  StartArray,
  AfterArrayValue,
  StartObject,
  AfterObjectKey,
  AfterObjectValue,
  BeforeObjectKey,
}

const jsonNumberPattern = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function parseJsonNumber(str: string): number {
  if (!jsonNumberPattern.test(str)) {
    throw new Error('Invalid number');
  }
  return Number(str);
}

export class Tokenizer {
  readonly input: Input;
  readonly #handler: TokenHandler;
  #stack = [State.ExpectingValue];
  #emittedTokens = 0;

  constructor(stream: AsyncIterable<string>, handler: TokenHandler) {
    this.input = new Input(stream);
    this.#handler = handler;
  }

  isDone(): boolean {
    return this.#stack.length === 0 && this.input.buffer.length === 0;
  }

  async pump(): Promise<void> {
    const start = this.#emittedTokens;
    while (true) {
      const before = this.#emittedTokens;
      this.#tokenizeMore();
      if (this.#emittedTokens > before) {
        // Keep processing buffered tokens until we've exhausted them so that
        // tokenization and parsing happen in larger batches.
        continue;
      }
      if (this.#emittedTokens > start) {
        // We emitted at least one token and can't make more progress without
        // additional input.
        return;
      }
      if (this.#stack.length === 0) {
        await this.input.expectEndOfContent();
        return;
      }
      const expanded = await this.input.tryToExpandBuffer();
      if (!expanded) {
        // No more input. Loop again so that any buffered tokens are processed
        // before we enforce the end-of-content check.
        continue;
      }
    }
  }

  #emit(type: JsonTokenType.Boolean, value: boolean): void;
  #emit(type: JsonTokenType.Number, value: number): void;
  #emit(type: JsonTokenType.StringMiddle, value: string): void;
  #emit(type: JsonTokenType, value: undefined): void;
  #emit(type: JsonTokenType, value: unknown) {
    this.#emittedTokens++;
    // An invalid cast, but the invariants between this method and that one
    // are the same.
    this.#handler.handleToken(type, value as undefined);
  }

  #tokenizeMore() {
    const state = this.#stack[this.#stack.length - 1];
    switch (state) {
      case State.ExpectingValue:
        this.#tokenizeValue();
        break;
      case State.InString:
        this.#tokenizeString();
        break;
      case State.StartArray:
        this.#tokenizeArrayStart();
        break;
      case State.AfterArrayValue:
        this.#tokenizeAfterArrayValue();
        break;
      case State.StartObject:
        this.#tokenizeObjectStart();
        break;
      case State.AfterObjectKey:
        this.#tokenizeAfterObjectKey();
        break;
      case State.AfterObjectValue:
        this.#tokenizeAfterObjectValue();
        break;
      case State.BeforeObjectKey:
        this.#tokenizeBeforeObjectKey();
        break;
      case undefined:
        return;
      default: {
        const never: never = state;
        throw new Error(`Unreachable: ${JSON.stringify(never)}`);
      }
    }
  }

  #tokenizeValue() {
    this.input.skipPastWhitespace();
    if (this.input.tryToTakePrefix('null')) {
      this.#emit(JsonTokenType.Null, undefined);
      this.#stack.pop();
      return;
    }
    if (this.input.tryToTakePrefix('true')) {
      this.#emit(JsonTokenType.Boolean, true);
      this.#stack.pop();
      return;
    }
    if (this.input.tryToTakePrefix('false')) {
      this.#emit(JsonTokenType.Boolean, false);
      this.#stack.pop();
      return;
    }
    if (/^[-0123456789]/.test(this.input.buffer)) {
      // Slightly tricky spot, because numbers don't have a terminator,
      // they might end on the end of input, or they might end because we hit
      // a non-number character.
      if (this.input.bufferComplete) {
        const match = this.input.buffer.match(/^[-+0123456789eE.]+/);
        if (!match) {
          throw new Error('Invalid number');
        }
        this.input.buffer = this.input.buffer.slice(match[0].length);
        const number = parseJsonNumber(match[0]);
        this.#emit(JsonTokenType.Number, number);
        this.#stack.pop();
        this.input.moreContentExpected = true;
        return;
      } else {
        // match up to the first non-number character
        const match = this.input.buffer.match(/[^-+0123456789eE.]/);
        if (!match) {
          // Return to expand the buffer, but since there's no terminator
          // for a number, we need to mark that finding the end of the input
          // isn't a sign of failure.
          this.input.moreContentExpected = false;
          return;
        }
        const numberChars = this.input.buffer.slice(0, match.index);
        this.input.buffer = this.input.buffer.slice(match.index);
        const number = parseJsonNumber(numberChars);
        this.#emit(JsonTokenType.Number, number);
        this.#stack.pop();
        return;
      }
    }
    if (this.input.tryToTakePrefix('"')) {
      this.#stack.pop();
      this.#stack.push(State.InString);
      this.#emit(JsonTokenType.StringStart, undefined);
      this.#tokenizeString();
      return;
    }
    if (this.input.tryToTakePrefix('[')) {
      this.#stack.pop();
      this.#stack.push(State.StartArray);
      this.#emit(JsonTokenType.ArrayStart, undefined);
      return this.#tokenizeArrayStart();
    }
    if (this.input.tryToTakePrefix('{')) {
      this.#stack.pop();
      this.#stack.push(State.StartObject);
      this.#emit(JsonTokenType.ObjectStart, undefined);
      return this.#tokenizeObjectStart();
    }
  }

  #tokenizeString() {
    while (true) {
      const [chunk, interrupted] = this.input.takeUntil(/["\\]/);
      if (chunk.length > 0) {
        // A string middle can't have a control character, newline, or tab
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f]/.test(chunk)) {
          throw new Error('Unescaped control character in string');
        }
        this.#emit(JsonTokenType.StringMiddle, chunk);
      } else if (!interrupted) {
        // We've parsed everything we can in the buffer.
        return;
      }
      if (interrupted) {
        if (this.input.buffer.length === 0) {
          // Can't continue without more input.
          return;
        }
        const nextChar = this.input.buffer[0];
        if (nextChar === '"') {
          this.input.buffer = this.input.buffer.slice(1);
          this.#emit(JsonTokenType.StringEnd, undefined);
          this.#stack.pop();
          return;
        }
        // string escapes
        const nextChar2 = this.input.buffer[1];
        if (nextChar2 === undefined) {
          // Can't continue without more input.
          return;
        }
        if (nextChar2 === 'u') {
          // need 4 more characters
          if (this.input.buffer.length < 6) {
            return;
          }
          const hex = this.input.buffer.slice(2, 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Error('Bad Unicode escape in JSON');
          }
          this.input.buffer = this.input.buffer.slice(6);
          this.#emit(
            JsonTokenType.StringMiddle,
            String.fromCharCode(parseInt(hex, 16)),
          );
          continue;
        } else {
          this.input.buffer = this.input.buffer.slice(2);
        }
        let value;
        switch (nextChar2) {
          case 'n':
            value = '\n';
            break;
          case 'r':
            value = '\r';
            break;
          case 't':
            value = '\t';
            break;
          case 'b':
            value = '\b';
            break;
          case 'f':
            value = '\f';
            break;
          case `\\`:
            value = `\\`;
            break;
          case '/':
            value = '/';
            break;
          case '"':
            value = '"';
            break;
          default:
            throw new Error('Bad escape in string');
        }
        this.#emit(JsonTokenType.StringMiddle, value);
      }
    }
  }

  #tokenizeArrayStart() {
    this.input.skipPastWhitespace();
    if (this.input.buffer.length === 0) {
      return;
    }
    if (this.input.tryToTakePrefix(']')) {
      this.#emit(JsonTokenType.ArrayEnd, undefined);
      this.#stack.pop();
      return;
    } else {
      this.#stack.pop();
      this.#stack.push(State.AfterArrayValue);
      this.#stack.push(State.ExpectingValue);
      this.#tokenizeValue();
    }
  }

  #tokenizeAfterArrayValue() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case ']': {
        this.#emit(JsonTokenType.ArrayEnd, undefined);
        this.#stack.pop();
        return;
      }
      case ',': {
        this.#stack.push(State.ExpectingValue);
        return this.#tokenizeValue();
      }
      default: {
        throw new Error('Expected , or ], got ' + JSON.stringify(nextChar));
      }
    }
  }

  #tokenizeObjectStart() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case '}': {
        this.#emit(JsonTokenType.ObjectEnd, undefined);
        this.#stack.pop();
        return;
      }
      case '"': {
        this.#stack.pop();
        this.#stack.push(State.AfterObjectKey);
        this.#stack.push(State.InString);
        this.#emit(JsonTokenType.StringStart, undefined);
        return this.#tokenizeString();
      }
      default: {
        throw new Error('Expected start of object key, got ' + nextChar);
      }
    }
  }

  #tokenizeAfterObjectKey() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case ':': {
        this.#stack.pop();
        this.#stack.push(State.AfterObjectValue);
        this.#stack.push(State.ExpectingValue);
        return this.#tokenizeValue();
      }
      default: {
        throw new Error('Expected colon after object key, got ' + nextChar);
      }
    }
  }

  #tokenizeAfterObjectValue() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case '}': {
        this.#emit(JsonTokenType.ObjectEnd, undefined);
        this.#stack.pop();
        return;
      }
      case ',': {
        this.#stack.pop();
        this.#stack.push(State.BeforeObjectKey);
        return this.#tokenizeBeforeObjectKey();
      }
      default: {
        throw new Error('Expected , or } after object value, got ' + nextChar);
      }
    }
  }

  #tokenizeBeforeObjectKey() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case '"': {
        this.#stack.pop();
        this.#stack.push(State.AfterObjectKey);
        this.#stack.push(State.InString);
        this.#emit(JsonTokenType.StringStart, undefined);
        return this.#tokenizeString();
      }
      default: {
        throw new Error('Expected start of object key, got ' + nextChar);
      }
    }
  }
}

/**
 * A part of the input that has been unambiguously decoded.
 *
 * Note that, due to StringMiddleToken the same input may be tokenized in
 * multiple equivalent ways depending on how it's chunked up in the input
 * stream.
 *
 * Implementation note: every token has a `value`, though most are undefined.
 * This is to give all tokens the same shape, to aid VM optimizations.
 */
export const enum JsonTokenType {
  Null,
  Boolean,
  Number,
  StringStart,
  StringMiddle,
  StringEnd,
  ArrayStart,
  ArrayEnd,
  ObjectStart,
  ObjectEnd,
}

export function jsonTokenTypeToString(type: JsonTokenType): string {
  switch (type) {
    case JsonTokenType.Null:
      return 'null';
    case JsonTokenType.Boolean:
      return 'boolean';
    case JsonTokenType.Number:
      return 'number';
    case JsonTokenType.StringStart:
      return 'string start';
    case JsonTokenType.StringMiddle:
      return 'string middle';
    case JsonTokenType.StringEnd:
      return 'string end';
    case JsonTokenType.ArrayStart:
      return 'array start';
    case JsonTokenType.ArrayEnd:
      return 'array end';
    case JsonTokenType.ObjectStart:
      return 'object start';
    case JsonTokenType.ObjectEnd:
      return 'object end';
  }
}

/** A complete boolean literal. */
export interface BooleanToken {
  readonly type: JsonTokenType.Boolean;
  readonly value: boolean;
}

/** A complete number literal. */
export interface NumberToken {
  readonly type: JsonTokenType.Number;
  readonly value: number;
}

/**
 * Our input buffer.
 *
 * This was more feature rich when we interleaved awaits while tokenizing.
 * Now that we're doing all the work synchronously, it's a bit overkill.
 */
class Input {
  buffer = '';
  // True if no more content will be added to the buffer.
  bufferComplete = false;
  moreContentExpected = true;
  #stream: AsyncIterator<string>;
  constructor(stream: AsyncIterable<string>) {
    this.#stream = stream[Symbol.asyncIterator]();
  }

  /**
   * Throws if there's any non-whitespace content left in the buffer or the
   * input stream.
   */
  async expectEndOfContent() {
    this.moreContentExpected = false;
    const check = () => {
      this.buffer = this.buffer.trim();
      if (this.buffer.length !== 0) {
        throw new Error(
          `Unexpected trailing content ${JSON.stringify(this.buffer)}`,
        );
      }
    };
    check();
    while (await this.tryToExpandBuffer()) {
      check();
    }
    check();
  }

  /**
   * Tries to read more content into the buffer.
   *
   * Returns false if the stream is exhausted.
   */
  async tryToExpandBuffer() {
    const result = await this.#stream.next();
    if (result.done) {
      this.bufferComplete = true;
      if (this.moreContentExpected) {
        throw new Error('Unexpected end of content');
      }
      return false;
    }
    this.buffer += result.value;
    return true;
  }

  skipPastWhitespace() {
    let i = 0;
    while (i < this.buffer.length) {
      const c = this.buffer.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        i++;
      } else {
        break;
      }
    }
    if (i > 0) {
      this.buffer = this.buffer.slice(i);
    }
  }

  /**
   * If the buffer starts with `prefix`, consumes it and returns true.
   */
  tryToTakePrefix(prefix: string): boolean {
    if (this.buffer.startsWith(prefix)) {
      this.buffer = this.buffer.slice(prefix.length);
      return true;
    }
    return false;
  }

  /**
   * Tries to take `len` characters from the buffer.
   *
   * If there are fewer than `len` characters in the buffer, returns undefined.
   */
  tryToTake(len: number): string | undefined {
    if (this.buffer.length < len) {
      return undefined;
    }
    const result = this.buffer.slice(0, len);
    this.buffer = this.buffer.slice(len);
    return result;
  }

  /**
   * Consumes and returns the input up to the first match of the given pattern.
   *
   * If the pattern is not found, consumes the entire buffer and returns it.
   *
   * Returns a tuple of the consumed content and a boolean indicating whether
   * the pattern was found.
   */
  takeUntil(pattern: RegExp): [string, boolean] {
    const match = pattern.exec(this.buffer);
    if (match) {
      const result = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index);
      return [result, true];
    }
    const result = this.buffer;
    this.buffer = '';
    return [result, false];
  }
}
