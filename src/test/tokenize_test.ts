/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as assert from 'node:assert/strict';
import {test, suite} from 'node:test';
import {tokenize, JsonTokenType} from '../tokenize.js';
import {makeStream, toArray} from './utils.js';

async function toFlatArray<T>(iter: AsyncIterable<T[]>): Promise<T[]> {
  return (await toArray(iter)).flat();
}

suite('tokenizeJsonStream', () => {
  test('can tokenize null', async () => {
    const tokens = tokenize(makeStream('null'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.Null, value: undefined},
    ]);
  });
  test('can tokenize empty array', async () => {
    const tokens = tokenize(makeStream('[]'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.ArrayStart, value: undefined},
      {type: JsonTokenType.ArrayEnd, value: undefined},
    ]);
  });
  test('can tokenize array with one element', async () => {
    const tokens = tokenize(makeStream('[null]'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.ArrayStart, value: undefined},
      {type: JsonTokenType.Null, value: undefined},
      {type: JsonTokenType.ArrayEnd, value: undefined},
    ]);
  });
  test('can tokenize array with two elements', async () => {
    const tokens = tokenize(makeStream('[null, true]'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.ArrayStart, value: undefined},
      {type: JsonTokenType.Null, value: undefined},
      {type: JsonTokenType.Boolean, value: true},
      {type: JsonTokenType.ArrayEnd, value: undefined},
    ]);
  });
  test('can tokenize an empty string', async () => {
    const tokens = tokenize(makeStream('""'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.StringStart, value: undefined},
      {type: JsonTokenType.StringEnd, value: undefined},
    ]);
  });
  test('can tokenize a string with one character', async () => {
    const tokens = tokenize(makeStream('"a"'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.String, value: 'a'},
    ]);
  });
  test('can tokenize a chunked string', async () => {
    const tokens = tokenize(makeStream('"', 'a', '"'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.StringStart, value: undefined},
      {type: JsonTokenType.StringMiddle, value: 'a'},
      {type: JsonTokenType.StringEnd, value: undefined},
    ]);
  });
  test('can tokenize a string with two characters', async () => {
    const tokens = tokenize(makeStream('"', 'a', 'b', '"'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.StringStart, value: undefined},
      {type: JsonTokenType.StringMiddle, value: 'a'},
      {type: JsonTokenType.StringMiddle, value: 'b'},
      {type: JsonTokenType.StringEnd, value: undefined},
    ]);
  });
  test('can tokenize a string with escapes', async () => {
    const tokens = tokenize(makeStream(JSON.stringify('"\\\n\u2028\t')));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.String, value: '"\\\n\u2028\t'},
    ]);
  });
  test('can tokenize an empty object', async () => {
    const tokens = tokenize(makeStream('{}'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.ObjectStart, value: undefined},
      {type: JsonTokenType.ObjectEnd, value: undefined},
    ]);
  });
  test('can tokenize an object with one key-value pair', async () => {
    const tokens = tokenize(makeStream('{"a": null}'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.ObjectStart, value: undefined},
      {type: JsonTokenType.String, value: 'a'},
      {type: JsonTokenType.Null, value: undefined},
      {type: JsonTokenType.ObjectEnd, value: undefined},
    ]);
  });
  test('can tokenize an object with two key-value pairs', async () => {
    const tokens = tokenize(makeStream('{"a": null, "b": true}'));
    assert.deepEqual(await toFlatArray(tokens), [
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
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.Number, value: 123},
    ]);
  });
  test('can tokenize a number split across chunks', async () => {
    const tokens = tokenize(makeStream('1', '23'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.Number, value: 123},
    ]);
  });
  test('can tokenize a decimal number split across chunks', async () => {
    const tokens = tokenize(makeStream('3.', '14'));
    assert.deepEqual(await toFlatArray(tokens), [
      {type: JsonTokenType.Number, value: 3.14},
    ]);
  });
});
