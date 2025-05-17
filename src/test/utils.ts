/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as assert from 'node:assert/strict';
import {parse} from '../index.js';

export async function* makeStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
  await void 0;
}

export function* makeStreams(val: string) {
  // The stream where we yield the entire input as one chunk
  yield {
    name: 'all at once',
    stream: (async function* () {
      yield val;
      await void 0;
    })(),
  };

  for (let chunkSize = 1; chunkSize < val.length; chunkSize++) {
    yield {
      name: `chunksize ${chunkSize}`,
      stream: makeStreamOfChunks(val, chunkSize),
    };
  }
}

export async function* makeStreamOfChunks(
  val: string,
  chunkSize: number,
): AsyncIterable<string> {
  let remaining = val;
  while (remaining.length > 0) {
    yield remaining.slice(0, chunkSize);
    remaining = remaining.slice(chunkSize);
  }
  await void 0;
}

export async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  try {
    for await (const item of iter) {
      result.push(item);
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

/**
 * Checks that parse(JSON.stringify(jsonValue)) === jsonValue
 */
export async function assertRoundTrips(jsonValue: unknown) {
  for (let indent = 0; indent < 3; indent++) {
    const json = JSON.stringify(jsonValue, null, indent);
    for (const {name, stream} of makeStreams(json)) {
      let finalValue;
      try {
        for await (const value of parse(stream)) {
          finalValue = value;
        }
      } catch (e) {
        throw new Error(
          `Parsing ${json} streamed with strategy "${name}" and indentation ${indent} resulted in ${
            (e as Error)?.stack
          }`,
          {cause: e},
        );
      }
      assert.deepEqual(
        finalValue,
        jsonValue,
        `Parsing ${json} streamed with strategy "${name}" and indentation ${indent}`,
      );
    }
  }
}

export async function emulatedJsonParse(json: string) {
  let finalValue;
  for await (const value of parse(makeStream(json))) {
    finalValue = value;
  }
  return finalValue;
}

export async function assertSameAsJsonParse(
  name: string,
  json: string,
  shouldSucceed: boolean | undefined,
) {
  let expected;
  let expectedError = null;
  try {
    expected = {success: true, value: JSON.parse(json) as unknown};
  } catch (e) {
    expected = {success: false};
    expectedError = e;
  }
  let actual;
  let actualError = null;
  try {
    actual = {success: true, value: await emulatedJsonParse(json)};
  } catch (e) {
    actual = {success: false};
    actualError = e;
  }
  assert.deepEqual(
    actual,
    expected,
    `${name} parsing ${JSON.stringify(json)}"\nActualError: ${(actualError as Error)?.stack}\nExpectedError: ${
      (expectedError as Error)?.stack
    }`,
  );
  if (shouldSucceed === true) {
    assert.ok(
      actual.success,
      `${name} expected success for ${JSON.stringify(json)} but failed with ${(expectedError as Error)?.stack}`,
    );
  } else if (shouldSucceed === false) {
    assert.ok(
      !actual.success,
      `${name} expected failure for ${JSON.stringify(json)}`,
    );
  }
}
