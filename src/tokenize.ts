/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

/**
 * Convert an async iterable of strings into an async iterable of JSON tokens.
 *
 * Throws if the input is not valid JSON, including if it has trailing content.
 */
export async function* tokenize(
  stream: AsyncIterable<string>,
): AsyncIterableIterator<JsonToken[]> {
  const tokenizer = new Tokenizer(stream);
  for await (const tokens of tokenizer) {
    yield tokens;
  }
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

class Tokenizer implements AsyncIterableIterator<JsonToken[]> {
  readonly input: Input;
  private outputBuffer: JsonToken[] = [];
  private stack = [State.ExpectingValue];
  constructor(stream: AsyncIterable<string>) {
    this.input = new Input(stream);
  }

  async next(): Promise<IteratorResult<JsonToken[], undefined>> {
    while (true) {
      const startingBufferLen = this.outputBuffer.length;
      this.tokenizeMore();
      if (this.outputBuffer.length > startingBufferLen) {
        continue;
      } else {
        // Can't progress the parse any more.
        // Do we have output ?
        if (this.outputBuffer.length > 0) {
          const tokens = this.outputBuffer;
          this.outputBuffer = [];
          return {done: false, value: tokens};
        }
        // Are we done?
        if (this.stack.length === 0) {
          await this.input.expectEndOfContent();
          return {done: true, value: undefined};
        }
        // Gotta wait for more content
        await this.input.tryToExpandBuffer();
      }
    }
  }

  private tokenizeMore() {
    const state = this.stack[this.stack.length - 1];
    switch (state) {
      case State.ExpectingValue:
        this.tokenizeValue();
        break;
      case State.InString:
        this.tokenizeString();
        break;
      case State.StartArray:
        this.tokenizeArrayStart();
        break;
      case State.AfterArrayValue:
        this.tokenizeAfterArrayValue();
        break;
      case State.StartObject:
        this.tokenizeObjectStart();
        break;
      case State.AfterObjectKey:
        this.tokenizeAfterObjectKey();
        break;
      case State.AfterObjectValue:
        this.tokenizeAfterObjectValue();
        break;
      case State.BeforeObjectKey:
        this.tokenizeBeforeObjectKey();
        break;
      case undefined:
        return;
      default: {
        const never: never = state;
        throw new Error(`Unreachable: ${JSON.stringify(never)}`);
      }
    }
  }

  private tokenizeValue() {
    this.input.skipPastWhitespace();
    if (this.input.tryToTakePrefix('null')) {
      this.outputBuffer.push({type: JsonTokenType.Null, value: undefined});
      this.stack.pop();
      return;
    }
    if (this.input.tryToTakePrefix('true')) {
      this.outputBuffer.push({type: JsonTokenType.Boolean, value: true});
      this.stack.pop();
      return;
    }
    if (this.input.tryToTakePrefix('false')) {
      this.outputBuffer.push({type: JsonTokenType.Boolean, value: false});
      this.stack.pop();
      return;
    }
    if (this.input.testBuffer(/^[-0123456789]/)) {
      // Slightly tricky spot, because numbers don't have a terminator,
      // they might end on the end of input, or they might end because we hit
      // a non-number character.
      if (this.input.bufferComplete) {
        const match = this.input.buffer.match(/^[-+0123456789eE.]+/);
        if (!match) {
          throw new Error('Invalid number');
        }
        this.input.buffer = this.input.buffer.slice(match[0].length);
        const number = JSON.parse(match[0]) as number;
        this.outputBuffer.push({type: JsonTokenType.Number, value: number});
        this.stack.pop();
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
        const number = JSON.parse(numberChars) as number;
        this.outputBuffer.push({type: JsonTokenType.Number, value: number});
        this.stack.pop();
        return;
      }
    }
    if (this.input.tryToTakePrefix('"')) {
      this.stack.pop();
      this.stack.push(State.InString);
      this.outputBuffer.push({
        type: JsonTokenType.StringStart,
        value: undefined,
      });
      this.tokenizeString();
      return;
    }
    if (this.input.tryToTakePrefix('[')) {
      this.stack.pop();
      this.stack.push(State.StartArray);
      this.outputBuffer.push({
        type: JsonTokenType.ArrayStart,
        value: undefined,
      });
      return this.tokenizeArrayStart();
    }
    if (this.input.tryToTakePrefix('{')) {
      this.stack.pop();
      this.stack.push(State.StartObject);
      this.outputBuffer.push({
        type: JsonTokenType.ObjectStart,
        value: undefined,
      });
      return this.tokenizeObjectStart();
    }
  }

  private tokenizeString() {
    const middlePart = {type: JsonTokenType.StringMiddle as const, value: ''};
    const addToMiddlePart = (val: string) => {
      if (middlePart.value === '') {
        this.outputBuffer.push(middlePart);
      }
      middlePart.value += val;
    };
    while (true) {
      const [chunk, interrupted] = this.input.takeUntil(/["\\]/);
      if (chunk.length > 0) {
        // A string middle can't have a control character, newline, or tab
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f]/.test(chunk)) {
          throw new Error('Unescaped control character in string');
        }
        addToMiddlePart(chunk);
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
          // Do we have a string middle and a string end in the buffer?
          // If so, optimize by combining them.
          if (
            this.outputBuffer.at(-1)?.type === JsonTokenType.StringMiddle &&
            this.outputBuffer.at(-2)?.type === JsonTokenType.StringStart
          ) {
            const middle = this.outputBuffer.pop() as StringMiddleToken;
            this.outputBuffer.pop();
            this.outputBuffer.push({
              type: JsonTokenType.String,
              value: middle.value,
            });
          } else {
            this.outputBuffer.push({
              type: JsonTokenType.StringEnd,
              value: undefined,
            });
          }
          this.stack.pop();
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
          this.input.buffer = this.input.buffer.slice(6);
          addToMiddlePart(JSON.parse(`"\\u${hex}"`) as string);
          continue;
        } else {
          this.input.buffer = this.input.buffer.slice(2);
        }
        let value;
        switch (nextChar2) {
          case 'n': {
            value = '\n';
            break;
          }
          case 'r': {
            value = '\r';
            break;
          }
          case 't': {
            value = '\t';
            break;
          }
          case 'b': {
            value = '\b';
            break;
          }
          case 'f': {
            value = '\f';
            break;
          }
          case `\\`: {
            value = `\\`;
            break;
          }
          case `/`: {
            value = `/`;
            break;
          }
          case '"': {
            value = '"';
            break;
          }
          default: {
            throw new Error('Bad escape in string');
          }
        }
        addToMiddlePart(value);
      }
    }
  }

  private tokenizeArrayStart() {
    this.input.skipPastWhitespace();
    if (this.input.buffer.length === 0) {
      return;
    }
    if (this.input.tryToTakePrefix(']')) {
      this.outputBuffer.push({
        type: JsonTokenType.ArrayEnd,
        value: undefined,
      });
      this.stack.pop();
      return;
    } else {
      this.stack.pop();
      this.stack.push(State.AfterArrayValue);
      this.stack.push(State.ExpectingValue);
      this.tokenizeValue();
    }
  }

  private tokenizeAfterArrayValue() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case ']': {
        this.outputBuffer.push({
          type: JsonTokenType.ArrayEnd,
          value: undefined,
        });
        this.stack.pop();
        return;
      }
      case ',': {
        this.stack.push(State.ExpectingValue);
        return this.tokenizeValue();
      }
      default: {
        throw new Error('Expected , or ], got ' + JSON.stringify(nextChar));
      }
    }
  }

  private tokenizeObjectStart() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case '}': {
        this.outputBuffer.push({
          type: JsonTokenType.ObjectEnd,
          value: undefined,
        });
        this.stack.pop();
        return;
      }
      case '"': {
        this.stack.pop();
        this.stack.push(State.AfterObjectKey);
        this.stack.push(State.InString);
        this.outputBuffer.push({
          type: JsonTokenType.StringStart,
          value: undefined,
        });
        return this.tokenizeString();
      }
      default: {
        throw new Error('Expected start of object key, got ' + nextChar);
      }
    }
  }

  private tokenizeAfterObjectKey() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case ':': {
        this.stack.pop();
        this.stack.push(State.AfterObjectValue);
        this.stack.push(State.ExpectingValue);
        return this.tokenizeValue();
      }
      default: {
        throw new Error('Expected colon after object key, got ' + nextChar);
      }
    }
  }

  private tokenizeAfterObjectValue() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case '}': {
        this.outputBuffer.push({
          type: JsonTokenType.ObjectEnd,
          value: undefined,
        });
        this.stack.pop();
        return;
      }
      case ',': {
        this.stack.pop();
        this.stack.push(State.BeforeObjectKey);
        return this.tokenizeBeforeObjectKey();
      }
      default: {
        throw new Error('Expected , or } after object value, got ' + nextChar);
      }
    }
  }

  private tokenizeBeforeObjectKey() {
    this.input.skipPastWhitespace();
    const nextChar = this.input.tryToTake(1);
    switch (nextChar) {
      case undefined: {
        return;
      }
      case '"': {
        this.stack.pop();
        this.stack.push(State.AfterObjectKey);
        this.stack.push(State.InString);
        this.outputBuffer.push({
          type: JsonTokenType.StringStart,
          value: undefined,
        });
        return this.tokenizeString();
      }
      default: {
        throw new Error('Expected start of object key, got ' + nextChar);
      }
    }
  }

  [Symbol.asyncIterator]() {
    return this;
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
export type JsonToken =
  | NullToken
  | BooleanToken
  | NumberToken
  | StringToken
  | StringStartToken
  | StringMiddleToken
  | StringEndToken
  | ArrayStartToken
  | ArrayEndToken
  | ObjectStartToken
  | ObjectEndToken;

export const enum JsonTokenType {
  Null,
  Boolean,
  Number,
  String,
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
    case JsonTokenType.String:
      return 'string';
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
 * A complete string literal.
 *
 * Emitted when we can get the entire string in a single chunk.
 */
export interface StringToken {
  readonly type: JsonTokenType.String;
  readonly value: string;
}

/**
 * The start of a string literal.
 *
 * A string literal is represented by a StringStartToken, any number of
 * StringMiddleTokens, then a StringEndToken.
 */
interface StringStartToken {
  readonly type: JsonTokenType.StringStart;
  readonly value: undefined;
}

/**
 * A portion of the content of a string literal.
 */
interface StringMiddleToken {
  readonly type: JsonTokenType.StringMiddle;
  /**
   * The decoded content of a portion of a string.
   *
   * Escape sequences (e.g. \n, \t, \\, \") have been processed.
   */
  readonly value: string;
}

/** The end of a string literal. */
interface StringEndToken {
  readonly type: JsonTokenType.StringEnd;
  readonly value: undefined;
}

/** A complete null literal. */
export interface NullToken {
  type: JsonTokenType.Null;
  value: undefined;
}

/** The beginning of an array literal. */
interface ArrayStartToken {
  type: JsonTokenType.ArrayStart;
  value: undefined;
}

/** The end of an array literal. */
interface ArrayEndToken {
  type: JsonTokenType.ArrayEnd;
  value: undefined;
}

/** The beginning of an object literal. */
interface ObjectStartToken {
  type: JsonTokenType.ObjectStart;
  value: undefined;
}

/** The end of an object literal. */
interface ObjectEndToken {
  type: JsonTokenType.ObjectEnd;
  value: undefined;
}

// Wrapper around an Input that can only progress it synchronously.
class SynchronousInput {
  readonly input: Input;
  constructor(input: Input) {
    this.input = input;
  }
}

/**
 * Our input buffer.
 *
 * This was more feature rich when we interleaved awaits while tokenizing.
 * Now that we're doing all the work synchronously, it's a bit overkill.
 */
class Input {
  buffer = '';
  // True if the no more content will be added to the buffer.
  bufferComplete = false;
  moreContentExpected = true;
  private stream: AsyncIterator<string>;
  readonly synchronous = new SynchronousInput(this);
  constructor(stream: AsyncIterable<string>) {
    this.stream = stream[Symbol.asyncIterator]();
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
    const result = await this.stream.next();
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
    // The only four whitespace characters in JSON are space,
    // tab, newline, and carriage return.
    const pattern = /^[ \n\r\t]+/;
    const match = pattern.exec(this.buffer);
    if (match) {
      this.buffer = this.buffer.slice(match.index + match[0].length);
    }
  }

  testBuffer(regex: RegExp): boolean {
    return regex.test(this.buffer);
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
