/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as assert from 'node:assert/strict';
import {test, suite} from 'node:test';
import {tokenize, JsonTokenType} from '../tokenize.js';

async function* makeStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
  await void 0;
}

async function toArray<T>(iter: AsyncIterable<T[]>): Promise<T[]> {
  const result: T[] = [];
  try {
    for await (const item of iter) {
      result.push(...item);
    }
  } catch (e) {
    throw new Error(
      `Error in toArray (result so far: ${JSON.stringify(result)}): ${
        (e as Error)?.stack
      } `,
    );
  }
  return result;
}

suite('tokenizeJsonStream', () => {
  test('can tokenize null', async () => {
    const tokens = tokenize(makeStream('null'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.Null, value: undefined},
    ]);
  });
  test('can tokenize empty array', async () => {
    const tokens = tokenize(makeStream('[]'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.ArrayStart, value: undefined},
      {type: JsonTokenType.ArrayEnd, value: undefined},
    ]);
  });
  test('can tokenize array with one element', async () => {
    const tokens = tokenize(makeStream('[null]'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.ArrayStart, value: undefined},
      {type: JsonTokenType.Null, value: undefined},
      {type: JsonTokenType.ArrayEnd, value: undefined},
    ]);
  });
  test('can tokenize array with two elements', async () => {
    const tokens = tokenize(makeStream('[null, true]'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.ArrayStart, value: undefined},
      {type: JsonTokenType.Null, value: undefined},
      {type: JsonTokenType.Boolean, value: true},
      {type: JsonTokenType.ArrayEnd, value: undefined},
    ]);
  });
  test('can tokenize an empty string', async () => {
    const tokens = tokenize(makeStream('""'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.StringStart, value: undefined},
      {type: JsonTokenType.StringEnd, value: undefined},
    ]);
  });
  test('can tokenize a string with one character', async () => {
    const tokens = tokenize(makeStream('"a"'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.String, value: 'a'},
    ]);
  });
  test('can tokenize a chunked string', async () => {
    const tokens = tokenize(makeStream('"', 'a', '"'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.StringStart, value: undefined},
      {type: JsonTokenType.StringMiddle, value: 'a'},
      {type: JsonTokenType.StringEnd, value: undefined},
    ]);
  });
  test('can tokenize a string with two characters', async () => {
    const tokens = tokenize(makeStream('"', 'a', 'b', '"'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.StringStart, value: undefined},
      {type: JsonTokenType.StringMiddle, value: 'a'},
      {type: JsonTokenType.StringMiddle, value: 'b'},
      {type: JsonTokenType.StringEnd, value: undefined},
    ]);
  });
  test('can tokenize a string with escapes', async () => {
    const tokens = tokenize(makeStream(JSON.stringify('"\\\n\u2028\t')));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.String, value: '"\\\n\u2028\t'},
    ]);
  });
  test('can tokenize an empty object', async () => {
    const tokens = tokenize(makeStream('{}'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.ObjectStart, value: undefined},
      {type: JsonTokenType.ObjectEnd, value: undefined},
    ]);
  });
  test('can tokenize an object with one key-value pair', async () => {
    const tokens = tokenize(makeStream('{"a": null}'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.ObjectStart, value: undefined},
      {type: JsonTokenType.String, value: 'a'},
      {type: JsonTokenType.Null, value: undefined},
      {type: JsonTokenType.ObjectEnd, value: undefined},
    ]);
  });
  test('can tokenize an object with two key-value pairs', async () => {
    const tokens = tokenize(makeStream('{"a": null, "b": true}'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.ObjectStart, value: undefined},
      {type: JsonTokenType.String, value: 'a'},
      {type: JsonTokenType.Null, value: undefined},
      {type: JsonTokenType.String, value: 'b'},
      {type: JsonTokenType.Boolean, value: true},
      {type: JsonTokenType.ObjectEnd, value: undefined},
    ]);
  });
  test('can tokenize a number', async () => {
    const tokens = tokenize(makeStream('123'));
    assert.deepEqual(await toArray(tokens), [
      {type: JsonTokenType.Number, value: 123},
    ]);
  });
});
