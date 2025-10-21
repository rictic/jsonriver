/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as assert from 'node:assert/strict';
import {suite, test} from 'node:test';
import {parse} from '../index.js';
import {assertSameAsJsonParse, makeStreamOfChunks, toArray} from './utils.js';
import fc from 'fast-check';

async function* mapStructuralClone<T>(
  iter: AsyncIterable<T>,
): AsyncIterableIterator<T> {
  for await (const val of iter) {
    yield structuredClone(val);
  }
}

// If run with TEST_HARDER or if running in CI, run more tests than usual.
const shouldTestHarder = !!process.env['TEST_HARDER'] || !!process.env['CI'];

if (shouldTestHarder) {
  const numRuns = fc.readConfigureGlobal().numRuns ?? 100;
  fc.configureGlobal({numRuns: numRuns * 100});
}

suite('property based tests', () => {
  test('valid json parses same as JSON.parse', async () => {
    return fc.assert(
      fc.asyncProperty(fc.json(), async (json) => {
        await assertSameAsJsonParse(json, JSON.stringify(json), true);
        return true;
      }),
    );
  });

  test('arbitrary strings parse the same', async () => {
    return fc.assert(
      fc.asyncProperty(fc.string(), async (json) => {
        await assertSameAsJsonParse(json, JSON.stringify(json), undefined);
        return true;
      }),
    );
  });

  const {jsonValue} = fc.letrec((tie) => {
    return {
      jsonValue: fc.oneof(
        fc.constant(null),
        fc.boolean(),
        fc.string(),
        fc.double(),
        tie('jsonArray'),
        tie('jsonObject'),
      ),
      jsonArray: fc.array(tie('jsonValue')),
      jsonObject: fc.dictionary(fc.string(), tie('jsonValue')),
    };
  });

  function incrementalValues(value: unknown): unknown[] {
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      return [value];
    }
    if (typeof value === 'string') {
      const result = [];
      for (let i = 0; i <= value.length; i++) {
        result.push(value.slice(0, i));
      }
      return result;
    }
    if (Array.isArray(value)) {
      const valueArr: unknown[] = value;
      const result: Array<unknown[]> = [[]];
      for (let i = 0; i < value.length; i++) {
        const itemValues = incrementalValues(value[i]);
        for (let j = 0; j < itemValues.length; j++) {
          result.push([...valueArr.slice(0, i), itemValues[j]]);
        }
      }
      return result;
    }
    if (typeof value !== 'object' || value === null) {
      throw new Error(`Unexpected value type: ${typeof value}`);
    }
    // we have an object
    const result: Array<object> = [{}];
    let baseObj: object = {};
    for (const [key, val] of Object.entries(value)) {
      const itemValues = incrementalValues(val);
      for (let j = 0; j < itemValues.length; j++) {
        result.push({...baseObj, [key]: itemValues[j]});
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      baseObj = {...baseObj, [key]: val};
    }
    return result;
  }

  test('we get incremental values as expected', async () => {
    return fc.assert(
      fc.asyncProperty(jsonValue, async (value: unknown) => {
        const jsonString = JSON.stringify(value);
        const expectedIncrementalValues: unknown[] = incrementalValues(
          JSON.parse(jsonString),
        );

        const stringStream = makeStreamOfChunks(jsonString, 1);
        const partialValues = await toArray(
          mapStructuralClone(parse(stringStream)),
        );
        assert.deepEqual(partialValues, expectedIncrementalValues);
        return true;
      }),
    );
  });

  function completeValues(
    value: unknown,
  ): Array<[unknown, Array<string | number>]> {
    if (
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string' ||
      value === null
    ) {
      return [[value, []]];
    }
    if (Array.isArray(value)) {
      const result: Array<[unknown, Array<string | number>]> = [];
      for (let i = 0; i < value.length; i++) {
        const itemValues = completeValues(value[i]);
        for (let j = 0; j < itemValues.length; j++) {
          const [itemValue, itemPath] = itemValues[j]!;
          result.push([itemValue, [i, ...itemPath]]);
        }
      }
      result.push([value, []]);
      return result;
    }
    if (typeof value !== 'object' || value === null) {
      throw new Error(`Unexpected value type: ${typeof value}`);
    }

    const result: Array<[unknown, Array<string | number>]> = [];
    for (const [key, val] of Object.entries(value)) {
      const itemValues = completeValues(val);
      for (let j = 0; j < itemValues.length; j++) {
        const [itemValue, itemPath] = itemValues[j]!;
        result.push([itemValue, [key, ...itemPath]]);
      }
    }
    result.push([value, []]);
    return result;
  }

  test('we are called for complete values as expected', async () => {
    return fc.assert(
      fc.asyncProperty(jsonValue, async (value: unknown) => {
        const stringStream = makeStreamOfChunks(JSON.stringify(value), 1);
        const actualCompleteValues: Array<[unknown, Array<string | number>]> =
          [];
        await toArray(
          parse(stringStream, (info) => {
            actualCompleteValues.push([info.value, [...info.pathSegments]]);
          }),
        );
        assert.deepEqual(
          actualCompleteValues,
          completeValues(JSON.parse(JSON.stringify(value))),
          `Complete values when parsing ${JSON.stringify(value)}}`,
        );
      }),
    );
  });

  test('strings only grow', async () => {
    // check the invariant
    function check(prev: unknown, curr: unknown) {
      if (typeof prev === 'string') {
        assert.ok(typeof curr === 'string');
        assert.ok(curr.length >= prev.length);
        assert.ok(curr.startsWith(prev));
      } else if (Array.isArray(prev)) {
        assert.ok(Array.isArray(curr));
        for (let i = 0; i < prev.length - 1; i++) {
          assert.deepEqual(curr[i], prev[i]);
        }
        if (prev.length > 0 && curr.length > 0) {
          check(prev[prev.length - 1], curr[prev.length - 1]);
        }
      } else if (typeof prev === 'object' && prev !== null) {
        assert.ok(typeof curr === 'object');
        assert.ok(curr !== null);
        const pKeys = Object.keys(prev);
        const nKeys = Object.keys(curr);
        for (let i = 0; i < pKeys.length - 1; i++) {
          const key = pKeys[i]!;
          assert.ok(Object.hasOwn(curr, key));
          assert.deepEqual(
            (curr as {[key: string]: unknown})[key],
            (prev as {[key: string]: unknown})[key],
          );
        }
        if (pKeys.length > 0 && nKeys.length > 0) {
          const lastPKey = pKeys[pKeys.length - 1]!;
          if (Object.hasOwn(curr, lastPKey)) {
            check(
              (prev as {[key: string]: unknown})[lastPKey],
              (curr as {[key: string]: unknown})[lastPKey],
            );
          }
        }
      }
    }

    return fc.assert(
      fc.asyncProperty(jsonValue, async (value: unknown) => {
        const jsonString = JSON.stringify(value);
        const stringStream = makeStreamOfChunks(jsonString, 1);
        let previous: unknown = undefined;
        for await (const next of parse(stringStream)) {
          if (previous === undefined) {
            previous = structuredClone(next);
            continue;
          }
          check(previous, next);
          previous = structuredClone(next);
        }
      }),
    );
  });

  test('atomic values are atomic', async () => {
    return fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(null), fc.boolean(), fc.double()),
        async (value: unknown) => {
          const jsonString = JSON.stringify(value);
          const stringStream = makeStreamOfChunks(jsonString, 1);
          const partialValues = await toArray(
            mapStructuralClone(parse(stringStream)),
          );
          assert.deepEqual(partialValues, [JSON.parse(JSON.stringify(value))]);
        },
      ),
    );
  });

  test('objects with arbitrary keys', async () => {
    const keyValuePairs = fc.array(fc.tuple(fc.string(), jsonValue));
    return fc.assert(
      fc.asyncProperty(keyValuePairs, async (entries) => {
        const jsonString =
          '{' +
          entries
            .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
            .join(',') +
          '}';
        await assertSameAsJsonParse('Randomly', jsonString, undefined);
      }),
    );
  });

  test('duplicate keys behave like JSON.parse', async () => {
    const keyValuePairs = fc.array(fc.tuple(fc.string(), jsonValue), {
      minLength: 1,
    });
    return fc.assert(
      fc.asyncProperty(keyValuePairs, async (entries) => {
        const jsonString =
          '{' +
          [...entries, ...entries]
            .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
            .join(',') +
          '}';
        await assertSameAsJsonParse(
          'Randomly generated',
          jsonString,
          undefined,
        );
      }),
    );
  });
});
