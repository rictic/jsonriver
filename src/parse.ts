/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import { PeekableAsyncIterableIterator } from "./peekable.js";
import {
  JsonTokenType,
  jsonTokenTypeToString,
  JsonToken,
  tokenize,
} from "./tokenize.js";

/**
 * Incrementally parses a single JSON value from the given iterable of string
 * chunks.
 *
 * Yields a sequence of increasingly complete JSON values as more of the input
 * can be parsed. The final value yielded will be the same as running JSON.parse
 * on the entire input as a single string. If the input is not valid JSON,
 * throws an error in the same way that JSON.parse would, though the error
 * message is not guaranteed to be the same.
 *
 * When possible (i.e. with objects and arrays), the yielded JSON values will
 * be reused. This means that if you store a reference to a yielded value, it
 * will be updated in place as more of the input is parsed.
 *
 * As with JSON.parse, this throws if non-whitespace trailing content is found.
 *
 * The following invariants will also be maintained:
 *
 * 1. Future versions of a value will have the same type. i.e. we will never
 *    yield a value as a string and then later replace it with an array.
 * 2. true, false, null, and numbers are atomic, we don't yield them until
 *    we have the entire value.
 * 3. Strings may be replaced with a longer string, with more characters (in
 *    the JavaScript sense) appended.
 * 4. Arrays are only modified by either appending new elements, or
 *    replacing/mutating the element currently at the end.
 * 5. Objects are only modified by either adding new properties, or
 *    replacing/mutating the most recently added property.
 * 6. As a consequence of 1 and 5, we only add a property to an object once we
 *    have the entire key and enough of the value to know that value's type.
 */
export async function* parse(
  stream: AsyncIterable<string>
): AsyncIterableIterator<JsonValue> {
  const tokens = new PeekableAsyncIterableIterator(tokenize(stream));
  yield* parseValue(tokens);
  // now we expect the stream to be empty
  const next = await tokens.next();
  if (!next.done) {
    throw new Error("Unexpected token: " + JSON.stringify(next.value));
  }
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

async function* parseValue(
  tokens: PeekableAsyncIterableIterator<JsonToken>
): AsyncIterableIterator<JsonValue> {
  const next = await tokens.next();
  if (next.done) {
    throw new Error(
      "Unexpected end of input while expecting the start of a new value"
    );
  }
  switch (next.value.type) {
    case JsonTokenType.Null:
      yield null;
      return;
    case JsonTokenType.Boolean:
      yield next.value.value;
      return;
    case JsonTokenType.Number:
      yield next.value.value;
      return;
    case JsonTokenType.StringStart:
      yield* parseString(tokens);
      return;
    case JsonTokenType.ArrayStart:
      yield* parseArray(tokens);
      return;
    case JsonTokenType.ObjectStart:
      yield* parseObject(tokens);
      return;
    default:
      throw new Error("Unexpected token type: " + next.value.type);
  }
}

/**
 * Puts together a string from a sequence of StringMiddles followed by a
 * StringEnd.
 *
 * Expects that the StringStart has already been consumed.
 */
async function* parseString(
  tokens: AsyncIterableIterator<JsonToken>
): AsyncIterableIterator<string> {
  let result = "";
  yield result;
  for await (const token of tokens) {
    switch (token.type) {
      case JsonTokenType.StringMiddle:
        result += token.value;
        yield result;
        break;
      case JsonTokenType.StringEnd:
        return;
      default:
        throw new Error(
          `Unexpected token type in the middle of string: ${jsonTokenTypeToString(
            token.type
          )}`
        );
    }
  }
}

/**
 * Puts together an array from a sequence of values followed by an ArrayEnd.
 *
 * Expects that the ArrayStart has already been consumed.
 */
async function* parseArray(
  tokens: PeekableAsyncIterableIterator<JsonToken>
): AsyncIterableIterator<JsonValue[]> {
  let result: JsonValue[] = [];
  yield result;
  while (true) {
    const nextPeek = await tokens.peek();
    if (nextPeek.done) {
      throw new Error("Unexpected end of input in the middle of array");
    }
    switch (nextPeek.value.type) {
      case JsonTokenType.ArrayEnd:
        await tokens.next();
        return;
      default: {
        const values = parseValue(tokens);
        const firstValue = await values.next();
        if (firstValue.done) {
          throw new Error("Unexpected end of input in the middle of array");
        }
        result.push(firstValue.value);
        yield result;
        let index = result.length - 1;
        for await (const updatedValue of values) {
          result[index] = updatedValue;
          yield result;
        }
      }
    }
  }
}

/**
 * Puts together an object from a sequence of key-value pairs followed by an
 * ObjectEnd.
 *
 * Expects that the ObjectStart has already been consumed.
 */
async function* parseObject(
  tokens: PeekableAsyncIterableIterator<JsonToken>
): AsyncIterableIterator<{ [key: string]: JsonValue }> {
  let result: { [key: string]: JsonValue } = {};
  yield result;
  while (true) {
    const nextVal = await tokens.next();
    if (nextVal.done) {
      throw new Error("Unexpected end of input in the middle of object");
    }
    if (nextVal.value.type === JsonTokenType.ObjectEnd) {
      return;
    }
    if (nextVal.value.type !== JsonTokenType.StringStart) {
      throw new Error(
        `Unexpected token type in the middle of object: ${jsonTokenTypeToString(
          nextVal.value.type
        )}`
      );
    }

    let key;
    for await (const keyValue of parseString(tokens)) {
      key = keyValue;
      // don't yield while we're still parsing the key, keys are rarely
      // long, and it's unlikely that the consuming code can do anything useful
      // with a partial key
    }
    if (key === undefined) {
      throw new Error("Internal error: key should not be undefined");
    }
    for await (const value of await parseValue(tokens)) {
      result[key] = value;
      yield result;
    }
    if (!(key in result)) {
      throw new Error("Internal error: key should be in result");
    }
  }
}
