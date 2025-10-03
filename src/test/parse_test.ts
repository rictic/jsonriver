/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {suite, test} from 'node:test';
import {parse} from '../index.js';
import {
  assertRoundTrips,
  assertSameAsJsonParse,
  makeStreamOfChunks,
  toArray,
} from './utils.js';

async function* mapStructuralClone<T>(
  iter: AsyncIterable<T>,
): AsyncIterableIterator<T> {
  for await (const val of iter) {
    yield structuredClone(val);
  }
}

suite('parse', () => {
  test('round tripping', async (t) => {
    const jsonValues = [
      {
        a: [{b: ''}],
        c: '',
      },

      // null
      null,
      // booleans
      true,
      false,
      // numbers
      0,
      1,
      -1,
      123,
      100e100,

      // strings
      '',
      'a',
      'ab',
      'a\nb',
      // arrays
      [],
      [null],
      [null, true],
      [null, true, 'a b c d e\n]["\\"] f g'],
      // objects
      {},
      {a: null},
      {a: null, b: true},
      {a: null, b: true, c: 'a b c d e\n]["\\"] f g'},
      // // nested arrays and objects
      [[], {}],
      [{}, []],
      {a: []},
      {a: [], b: {}},
      {a: {}, b: []},
      {
        a: [null, true, 'a b c d e\n]["\\"]}{}}{{}} f g'],
        b: {c: 'a b c d e\n]["\\"] f g'},
      },
      {
        a: [{b: ''}],
        c: '',
      },
      {
        a: {
          b: {
            c: {
              d: {
                e: {
                  f: {
                    v: {w: {x: {y: {z: null}}}},
                  },
                },
              },
            },
          },
        },
      },
    ] as const;
    for (const [i, jsonValue] of jsonValues.entries()) {
      await t.test(`case ${i}`, async () => {
        await assertRoundTrips(jsonValue);
      });
    }
  });

  test('first 64k characters behave properly', async () => {
    // For the first 64Ki characters, check that they round trip,
    // and that they're treated the same as JSON.parse when inserted in
    // a string literal directly, and when decoded using a u escape.
    for (let i = 0; i <= 0xffff; i++) {
      const charcodeStr = String.fromCharCode(i);
      const hex = i.toString(16).padStart(4, '0');
      await assertSameAsJsonParse(
        `literal U+${hex}`,
        `"${charcodeStr}"`,
        undefined,
      );
      await assertSameAsJsonParse(
        `\\u escape U+${hex}`,
        `"\\u${hex}"`,
        undefined,
      );
    }
  });

  test('first 64k values', async () => {
    // Generated with my FEAT based reverse parser.
    const jsonVals = readFileSync(
      join(import.meta.filename, '../../../src/test/jsonhead.txt'),
      'utf-8',
    )
      .trim()
      .split('\n');
    for (const [i, str] of jsonVals.entries()) {
      await assertSameAsJsonParse(`value ${i}`, str, true);
    }
  });

  test('partial results', async () => {
    const inputToOutputs = [
      [null, [null]],
      [true, [true]],
      [false, [false]],
      ['abc', ['', 'a', 'ab', 'abc']],
      [[], [[]]],
      [
        ['a', 'b', 'c'],
        [
          [],
          [''],
          ['a'],
          ['a', ''],
          ['a', 'b'],
          ['a', 'b', ''],
          ['a', 'b', 'c'],
        ],
      ],
      [
        {greeting: 'hi!', name: 'G'},
        [
          {},
          {greeting: ''},
          {greeting: 'h'},
          {greeting: 'hi'},
          {greeting: 'hi!'},
          {greeting: 'hi!', name: ''},
          {greeting: 'hi!', name: 'G'},
        ],
      ],
      [
        {a: ['a', {b: ['c']}]},
        [
          {},
          {a: []},
          {a: ['']},
          {a: ['a']},
          {a: ['a', {}]},
          {a: ['a', {b: []}]},
          {a: ['a', {b: ['']}]},
          {a: ['a', {b: ['c']}]},
        ],
      ],
    ];
    for (const [val, expectedVals] of inputToOutputs) {
      const stringStream = makeStreamOfChunks(JSON.stringify(val), 1);
      const partialValues = await toArray(
        mapStructuralClone(parse(stringStream)),
      );
      assert.deepEqual(
        partialValues,
        expectedVals as unknown,
        `Parsing ${JSON.stringify(val)}`,
      );
    }
  });

  test('deep nesting', async () => {
    // Test that we can parse deeply nested structures (> 100 levels)
    let deepArray = '';
    const depth = 1_000_000;
    for (let i = 0; i < depth; i++) {
      deepArray += '[';
    }
    deepArray += '1';
    for (let i = 0; i < depth; i++) {
      deepArray += ']';
    }

    const stream = makeStreamOfChunks(deepArray, 100);
    type Val = number | [Val];
    let result: Val | undefined;
    for await (const val of parse(stream)) {
      result = val as Val;
    }
    assert.ok(result, 'Should parse deeply nested array');

    // Verify depth by walking down

    let current = result;
    for (let i = 0; i < depth; i++) {
      if (!Array.isArray(current)) {
        assert.equal(current, 1, `At depth ${i}, should reach value 1`);
        break;
      }
      current = current[0];
    }
    assert.equal(current, 1, 'At max depth, should reach value 1');
  });
});
