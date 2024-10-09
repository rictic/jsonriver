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
  stream: AsyncIterable<string>
): AsyncIterableIterator<JsonToken> {
  const input = new Input(stream);
  yield* tokenizeOneValue(input);
  await input.expectEndOfContent();
}

async function* tokenizeOneValue(
  input: Input
): AsyncIterableIterator<JsonToken> {
  while (true) {
    await input.skipWhitespace();
    if (input.tryToTake("null")) {
      yield { type: JsonTokenType.Null, value: undefined };
      return;
    }
    if (input.tryToTake("true")) {
      yield { type: JsonTokenType.Boolean, value: true };
      return;
    }
    if (input.tryToTake("false")) {
      yield { type: JsonTokenType.Boolean, value: false };
      return;
    }
    if (input.tryToTake('"')) {
      yield* tokenizeStringContents(input);
      return;
    }
    if (input.tryToTake("[")) {
      yield { type: JsonTokenType.ArrayStart, value: undefined };
      await input.skipWhitespace();
      const maybeClose = await input.peek(1);
      if (maybeClose === "]") {
        await input.take(1);
        yield { type: JsonTokenType.ArrayEnd, value: undefined };
        return;
      }

      while (true) {
        yield* tokenizeOneValue(input);
        await input.skipWhitespace();
        const nextChar = await input.take(1);
        if (nextChar === "]") {
          yield { type: JsonTokenType.ArrayEnd, value: undefined };
          return;
        } else if (nextChar === ",") {
          continue;
        } else {
          throw new Error(
            "Unexpected character in the middle of array: " + nextChar
          );
        }
      }
    }
    if (input.tryToTake("{")) {
      yield { type: JsonTokenType.ObjectStart, value: undefined };
      await input.skipWhitespace();
      const nextChar2 = await input.peek(1);
      if (nextChar2 === "}") {
        await input.take(1);
        yield { type: JsonTokenType.ObjectEnd, value: undefined };
        return;
      }

      while (true) {
        await input.skipWhitespace();
        await input.matchPrefixOrDie('"');
        yield* tokenizeStringContents(input);
        await input.skipWhitespace();
        await input.matchPrefixOrDie(":");
        yield* tokenizeOneValue(input);
        await input.skipWhitespace();
        const nextChar = await input.take(1);
        if (nextChar === "}") {
          yield { type: JsonTokenType.ObjectEnd, value: undefined };
          return;
        } else if (nextChar === ",") {
          continue;
        } else {
          throw new Error(
            "Expected character in the middle of object: " + nextChar
          );
        }
      }
    }
    if (input.testBuffer(/^[\-0-9]/)) {
      yield* tokenizeNumber(input);
      return;
    }

    await input.expectMoreContent();
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
  | StringStartToken
  | StringMiddleToken
  | StringEndToken
  | ArrayStartToken
  | ArrayEndToken
  | ObjectStartToken
  | ObjectEndToken;

export enum JsonTokenType {
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
      return "null";
    case JsonTokenType.Boolean:
      return "boolean";
    case JsonTokenType.Number:
      return "number";
    case JsonTokenType.StringStart:
      return "string start";
    case JsonTokenType.StringMiddle:
      return "string middle";
    case JsonTokenType.StringEnd:
      return "string end";
    case JsonTokenType.ArrayStart:
      return "array start";
    case JsonTokenType.ArrayEnd:
      return "array end";
    case JsonTokenType.ObjectStart:
      return "object start";
    case JsonTokenType.ObjectEnd:
      return "object end";
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

async function* tokenizeStringContents(
  input: Input
): AsyncIterableIterator<JsonToken> {
  yield { type: JsonTokenType.StringStart, value: undefined };
  while (true) {
    const [chunk, interrupted] = input.takeUntil(/["\\]/);
    if (chunk.length > 0) {
      // A string middle can't have a control character, newline, or tab
      if (/[\x00-\x1f]/.test(chunk)) {
        throw new Error("Unescaped control character in string");
      }
      yield { type: JsonTokenType.StringMiddle, value: chunk };
    } else if (!interrupted) {
      await input.expectMoreContent();
      continue;
    }
    if (interrupted) {
      const nextChar = await input.take(1);
      if (nextChar === '"') {
        yield { type: JsonTokenType.StringEnd, value: undefined };
        return;
      }
      // string escapes
      const nextChar2 = await input.take(1);
      let value;
      switch (nextChar2) {
        case "n": {
          value = "\n";
          break;
        }
        case "r": {
          value = "\r";
          break;
        }
        case "t": {
          value = "\t";
          break;
        }
        case "b": {
          value = "\b";
          break;
        }
        case "f": {
          value = "\f";
          break;
        }
        case "u": {
          const hex = await input.take(4);
          value = JSON.parse(`"\\u${hex}"`);
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
          throw new Error("Bad escape in string");
        }
      }
      yield { type: JsonTokenType.StringMiddle, value };
    }
  }
}

async function* tokenizeNumber(input: Input): AsyncIterableIterator<JsonToken> {
  const str = await input.takeFullMatch(/^[\-+0123456789eE\.]+/);
  // Easy way to match the behavior of JSON.parse is to just call it!
  const number = JSON.parse(str) as number;
  yield { type: JsonTokenType.Number, value: number };
}

/**
 * Our input buffer, supporting a number of peeking, taking, and skipping
 * operations.
 */
class Input {
  private buffer = "";
  private stream: AsyncIterator<string>;
  constructor(stream: AsyncIterable<string>) {
    this.stream = stream[Symbol.asyncIterator]();
  }

  /** Expands the buffer. Throws if the input stream is exhausted. */
  async expectMoreContent() {
    const { done, value } = await this.stream.next();
    if (done) {
      throw new Error("Unexpected end of input");
    }
    this.buffer += value;
  }

  /**
   * Throws if there's any non-whitespace content left in the buffer or the
   * input stream.
   */
  async expectEndOfContent() {
    const check = () => {
      this.buffer = this.buffer.trim();
      if (this.buffer.length !== 0) {
        throw new Error(
          `Unexpected trailing content ${JSON.stringify(this.buffer)}`
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
    const { done, value } = await this.stream.next();
    if (done) {
      return false;
    }
    this.buffer += value;
    return true;
  }

  /**
   * Skips past whitespace in the input.
   *
   * Once this method returns, the buffer is non-empty, and the first character
   * is not whitespace. Throws if that's not possible.
   */
  async skipWhitespace() {
    // The only four whitespace characters in JSON are space,
    // tab, newline, and carriage return.
    const pattern = /[^ \n\r\t]/;
    while (true) {
      const match = pattern.exec(this.buffer);
      if (match) {
        this.buffer = this.buffer.slice(match.index);
        return;
      }
      await this.expectMoreContent();
    }
  }

  /**
   * Returns the next `len` characters in the input without consuming them.
   *
   * Throws if the input is exhausted before `len` characters are available.
   */
  async peek(len: number): Promise<string> {
    while (this.buffer.length < len) {
      await this.expectMoreContent();
    }
    return this.buffer.slice(0, len);
  }

  testBuffer(regex: RegExp): boolean {
    return regex.test(this.buffer);
  }

  /**
   * If the buffer starts with `prefix`, consumes it and returns true.
   */
  tryToTake(prefix: string): boolean {
    if (this.buffer.startsWith(prefix)) {
      this.buffer = this.buffer.slice(prefix.length);
      return true;
    }
    return false;
  }

  /**
   * Consumes and returns the next `len` characters in the input.
   *
   * Throws if the input is exhausted before `len` characters are available.
   */
  async take(len: number): Promise<string> {
    while (this.buffer.length < len) {
      await this.expectMoreContent();
    }
    const result = this.buffer.slice(0, len);
    this.buffer = this.buffer.slice(len);
    return result;
  }

  /**
   * Consumes the given string from the input.
   *
   * Throws if the input does not start with the given string.
   */
  async matchPrefixOrDie(prefix: string): Promise<void> {
    while (this.buffer.length < prefix.length) {
      await this.expectMoreContent();
    }
    if (!this.buffer.startsWith(prefix)) {
      throw new Error(
        "Expected " + prefix + " but got " + this.buffer.slice(0, prefix.length)
      );
    }
    this.buffer = this.buffer.slice(prefix.length);
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
    this.buffer = "";
    return [result, false];
  }

  /**
   * Takes the longest prefix of the input that matches the given pattern.
   *
   * NOTE: this method is only legal to call with a RegExp that
   * matches one or more single characters from the front of the input, like:
   * /^[abc]+/
   */
  async takeFullMatch(pattern: RegExp): Promise<string> {
    while (true) {
      const match = this.buffer.match(pattern);
      if (!match) {
        await this.expectMoreContent();
        continue;
      }
      // Did the pattern match the full buffer?
      if (match[0] === this.buffer) {
        if (await this.tryToExpandBuffer()) {
          // we expanded the buffer, so try again with the bigger buffer
          continue;
        }
        // we're at the end of the input, and it all matches
        this.buffer = "";
        return match[0];
      }
      this.buffer = this.buffer.slice(match[0].length);
      return match[0];
    }
  }
}
