/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

export interface TokenHandler {
  handleNull(): void;
  handleBoolean(value: boolean): void;
  handleNumber(value: number): void;
  handleStringStart(): void;
  handleStringMiddle(value: string): void;
  handleStringEnd(): void;
  handleArrayStart(): void;
  handleArrayEnd(): void;
  handleObjectStart(): void;
  handleObjectEnd(): void;
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
    return this.#stack.length === 0 && this.input.length === 0;
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
        this.input.commit();
        return;
      }
      if (this.#stack.length === 0) {
        await this.input.expectEndOfContent();
        this.input.commit();
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

  #emit(type: JsonTokenType.Null): void;
  #emit(type: JsonTokenType.Boolean, value: boolean): void;
  #emit(type: JsonTokenType.Number, value: number): void;
  #emit(type: JsonTokenType.StringStart): void;
  #emit(type: JsonTokenType.StringMiddle, value: string): void;
  #emit(type: JsonTokenType.StringEnd): void;
  #emit(type: JsonTokenType.ArrayStart): void;
  #emit(type: JsonTokenType.ArrayEnd): void;
  #emit(type: JsonTokenType.ObjectStart): void;
  #emit(type: JsonTokenType.ObjectEnd): void;
  #emit(type: JsonTokenType, value?: unknown) {
    this.#emittedTokens++;
    switch (type) {
      case JsonTokenType.Null:
        this.#handler.handleNull();
        break;
      case JsonTokenType.Boolean:
        this.#handler.handleBoolean(value as boolean);
        break;
      case JsonTokenType.Number:
        this.#handler.handleNumber(value as number);
        break;
      case JsonTokenType.StringStart:
        this.#handler.handleStringStart();
        break;
      case JsonTokenType.StringMiddle:
        this.#handler.handleStringMiddle(value as string);
        break;
      case JsonTokenType.StringEnd:
        this.#handler.handleStringEnd();
        break;
      case JsonTokenType.ArrayStart:
        this.#handler.handleArrayStart();
        break;
      case JsonTokenType.ArrayEnd:
        this.#handler.handleArrayEnd();
        break;
      case JsonTokenType.ObjectStart:
        this.#handler.handleObjectStart();
        break;
      case JsonTokenType.ObjectEnd:
        this.#handler.handleObjectEnd();
        break;
    }
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
      this.#emit(JsonTokenType.Null);
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
    if (this.input.length > 0) {
      const ch = this.input.peekCharCode(0);
      if ((ch >= 48 && ch <= 57) || ch === 45) {
        // Slightly tricky spot, because numbers don't have a terminator,
        // they might end on the end of input, or they might end because we hit
        // a non-number character.
        // Scan for the end of the number without allocating the entire
        // remaining buffer.
        let i = 0;
        while (i < this.input.length) {
          const c = this.input.peekCharCode(i);
          if (
            (c >= 48 && c <= 57) ||
            c === 45 ||
            c === 43 ||
            c === 46 ||
            c === 101 ||
            c === 69
          ) {
            i++;
          } else {
            break;
          }
        }
        if (i === this.input.length && !this.input.bufferComplete) {
          // Return to expand the buffer, but since there's no terminator for a
          // number, we need to mark that finding the end of the input isn't a
          // sign of failure.
          this.input.moreContentExpected = false;
          return;
        }
        const numberChars = this.input.slice(0, i);
        this.input.advance(i);
        const number = parseJsonNumber(numberChars);
        this.#emit(JsonTokenType.Number, number);
        this.#stack.pop();
        this.input.moreContentExpected = true;
        return;
      }
    }
    if (this.input.tryToTakePrefix('"')) {
      this.#stack.pop();
      this.#stack.push(State.InString);
      this.#emit(JsonTokenType.StringStart);
      this.#tokenizeString();
      return;
    }
    if (this.input.tryToTakePrefix('[')) {
      this.#stack.pop();
      this.#stack.push(State.StartArray);
      this.#emit(JsonTokenType.ArrayStart);
      return this.#tokenizeArrayStart();
    }
    if (this.input.tryToTakePrefix('{')) {
      this.#stack.pop();
      this.#stack.push(State.StartObject);
      this.#emit(JsonTokenType.ObjectStart);
      return this.#tokenizeObjectStart();
    }
  }

  #tokenizeString() {
    while (true) {
      const [chunk, interrupted] = this.input.takeUntilQuoteOrBackslash();
      if (chunk.length > 0) {
        this.#emit(JsonTokenType.StringMiddle, chunk);
      } else if (!interrupted) {
        // We've parsed everything we can in the buffer.
        return;
      }
      if (interrupted) {
        if (this.input.length === 0) {
          // Can't continue without more input.
          return;
        }
        const nextChar = this.input.peek(0);
        if (nextChar === '"') {
          this.input.advance(1);
          this.#emit(JsonTokenType.StringEnd);
          this.#stack.pop();
          return;
        }
        // string escapes
        const nextChar2 = this.input.peek(1);
        if (nextChar2 === undefined) {
          // Can't continue without more input.
          return;
        }
        if (nextChar2 === 'u') {
          // need 4 more characters
          if (this.input.length < 6) {
            return;
          }
          let code = 0;
          for (let j = 2; j < 6; j++) {
            const c = this.input.peekCharCode(j);
            const digit =
              c >= 48 && c <= 57
                ? c - 48
                : c >= 65 && c <= 70
                  ? c - 55
                  : c >= 97 && c <= 102
                    ? c - 87
                    : -1;
            if (digit === -1) {
              throw new Error('Bad Unicode escape in JSON');
            }
            code = (code << 4) | digit;
          }
          this.input.advance(6);
          this.#emit(JsonTokenType.StringMiddle, String.fromCharCode(code));
          continue;
        } else {
          this.input.advance(2);
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
    if (this.input.length === 0) {
      return;
    }
    if (this.input.tryToTakePrefix(']')) {
      this.#emit(JsonTokenType.ArrayEnd);
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
    const nextChar = this.input.tryToTakeCharCode();
    switch (nextChar) {
      case undefined: {
        return;
      }
      case 0x5d: {
        // ']'
        this.#emit(JsonTokenType.ArrayEnd);
        this.#stack.pop();
        return;
      }
      case 0x2c: {
        // ','
        this.#stack.push(State.ExpectingValue);
        return this.#tokenizeValue();
      }
      default: {
        throw new Error(
          'Expected , or ], got ' +
            JSON.stringify(String.fromCharCode(nextChar)),
        );
      }
    }
  }

  #tokenizeObjectStart() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTakeCharCode();
    switch (nextChar) {
      case undefined: {
        return;
      }
      case 0x7d: {
        // '}'
        this.#emit(JsonTokenType.ObjectEnd);
        this.#stack.pop();
        return;
      }
      case 0x22: {
        // '"'
        this.#stack.pop();
        this.#stack.push(State.AfterObjectKey);
        this.#stack.push(State.InString);
        this.#emit(JsonTokenType.StringStart);
        return this.#tokenizeString();
      }
      default: {
        throw new Error(
          'Expected start of object key, got ' +
            JSON.stringify(String.fromCharCode(nextChar)),
        );
      }
    }
  }

  #tokenizeAfterObjectKey() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTakeCharCode();
    switch (nextChar) {
      case undefined: {
        return;
      }
      case 0x3a: {
        // ':'
        this.#stack.pop();
        this.#stack.push(State.AfterObjectValue);
        this.#stack.push(State.ExpectingValue);
        return this.#tokenizeValue();
      }
      default: {
        throw new Error(
          'Expected colon after object key, got ' +
            JSON.stringify(String.fromCharCode(nextChar)),
        );
      }
    }
  }

  #tokenizeAfterObjectValue() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTakeCharCode();
    switch (nextChar) {
      case undefined: {
        return;
      }
      case 0x7d: {
        // '}'
        this.#emit(JsonTokenType.ObjectEnd);
        this.#stack.pop();
        return;
      }
      case 0x2c: {
        // ','
        this.#stack.pop();
        this.#stack.push(State.BeforeObjectKey);
        return this.#tokenizeBeforeObjectKey();
      }
      default: {
        throw new Error(
          'Expected , or } after object value, got ' +
            JSON.stringify(String.fromCharCode(nextChar)),
        );
      }
    }
  }

  #tokenizeBeforeObjectKey() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTakeCharCode();
    switch (nextChar) {
      case undefined: {
        return;
      }
      case 0x22: {
        // '"'
        this.#stack.pop();
        this.#stack.push(State.AfterObjectKey);
        this.#stack.push(State.InString);
        this.#emit(JsonTokenType.StringStart);
        return this.#tokenizeString();
      }
      default: {
        throw new Error(
          'Expected start of object key, got ' +
            JSON.stringify(String.fromCharCode(nextChar)),
        );
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
  #buffer = '';
  #startIndex = 0;
  // True if no more content will be added to the buffer.
  bufferComplete = false;
  moreContentExpected = true;
  #stream: AsyncIterator<string>;
  constructor(stream: AsyncIterable<string>) {
    this.#stream = stream[Symbol.asyncIterator]();
  }

  get length(): number {
    return this.#buffer.length - this.#startIndex;
  }

  advance(len: number) {
    this.#startIndex += len;
  }

  peek(offset: number): string | undefined {
    return this.#buffer[this.#startIndex + offset];
  }

  peekCharCode(offset: number): number {
    return this.#buffer.charCodeAt(this.#startIndex + offset);
  }

  slice(start: number, end: number): string {
    return this.#buffer.slice(this.#startIndex + start, this.#startIndex + end);
  }

  commit() {
    if (this.#startIndex > 0) {
      this.#buffer = this.#buffer.slice(this.#startIndex);
      this.#startIndex = 0;
    }
  }

  remaining(): string {
    return this.#buffer.slice(this.#startIndex);
  }

  /**
   * Throws if there's any non-whitespace content left in the buffer or the
   * input stream.
   */
  async expectEndOfContent() {
    this.moreContentExpected = false;
    const check = () => {
      this.commit();
      this.#buffer = this.#buffer.trim();
      if (this.#buffer.length !== 0) {
        throw new Error(
          `Unexpected trailing content ${JSON.stringify(this.#buffer)}`,
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
    this.#buffer += result.value;
    return true;
  }

  skipPastWhitespace() {
    let i = this.#startIndex;
    while (i < this.#buffer.length) {
      const c = this.#buffer.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        i++;
      } else {
        break;
      }
    }
    this.#startIndex = i;
  }

  /**
   * If the buffer starts with `prefix`, consumes it and returns true.
   */
  tryToTakePrefix(prefix: string): boolean {
    if (this.#buffer.startsWith(prefix, this.#startIndex)) {
      this.#startIndex += prefix.length;
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
    if (this.length < len) {
      return undefined;
    }
    const result = this.#buffer.slice(this.#startIndex, this.#startIndex + len);
    this.#startIndex += len;
    return result;
  }

  /**
   * Tries to take a single character from the buffer and returns its code.
   *
   * If there are no characters in the buffer, returns undefined.
   */
  tryToTakeCharCode(): number | undefined {
    if (this.length === 0) {
      return undefined;
    }
    const code = this.#buffer.charCodeAt(this.#startIndex);
    this.#startIndex++;
    return code;
  }

  /**
   * Consumes and returns the input up to the first quote or backslash.
   *
   * If neither not found, consumes the entire buffer and returns it.
   *
   * Returns a tuple of the consumed content and a boolean indicating whether
   * the pattern was found.
   */
  takeUntilQuoteOrBackslash(): [string, boolean] {
    const buf = this.#buffer;
    let i = this.#startIndex;
    while (i < buf.length) {
      const c = buf.charCodeAt(i);
      if (c <= 0x1f) {
        throw new Error('Unescaped control character in string');
      }
      if (c === 34 || c === 92) {
        const result = buf.slice(this.#startIndex, i);
        this.#startIndex = i;
        return [result, true];
      }
      i++;
    }
    const result = buf.slice(this.#startIndex);
    this.#startIndex = buf.length;
    return [result, false];
  }
}
