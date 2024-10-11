/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as assert from "node:assert/strict";
import { test, suite } from "node:test";
import { parse } from "../index.js";

async function* mapStructuralClone<T>(
  iter: AsyncIterable<T>
): AsyncIterableIterator<T> {
  for await (const val of iter) {
    yield structuredClone(val);
  }
}

function* makeStreams(val: string) {
  // The stream where we yield the entire input as one chunk
  yield {
    name: "all at once",
    stream: (async function* () {
      yield val;
    })(),
  };

  for (let chunkSize = 1; chunkSize < val.length; chunkSize++) {
    yield {
      name: `chunksize ${chunkSize}`,
      stream: makeStreamOfChunks(val, chunkSize),
    };
  }
}

async function* makeStreamOfChunks(
  val: string,
  chunkSize: number
): AsyncIterable<string> {
  let remaining = val;
  while (remaining.length > 0) {
    yield remaining.slice(0, chunkSize);
    remaining = remaining.slice(chunkSize);
  }
}

async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  try {
    for await (const item of iter) {
      result.push(item);
    }
  } catch (e) {
    throw new Error(
      `Error in toArray (result so far: ${JSON.stringify(result)}): ${
        (e as any)?.stack
      } `
    );
  }
  return result;
}

suite("parse", () => {
  test("round tripping", async () => {
    const jsonValues = [
      {
        a: [{ b: "" }],
        c: "",
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
      "",
      "a",
      "ab",
      "a\nb",
      // arrays
      [],
      [null],
      [null, true],
      [null, true, 'a b c d e\n]["\\"] f g'],
      // objects
      {},
      { a: null },
      { a: null, b: true },
      { a: null, b: true, c: 'a b c d e\n]["\\"] f g' },
      // // nested arrays and objects
      [[], {}],
      [{}, []],
      { a: [] },
      { a: [], b: {} },
      { a: {}, b: [] },
      {
        a: [null, true, 'a b c d e\n]["\\"]}{}}{{}} f g'],
        b: { c: 'a b c d e\n]["\\"] f g' },
      },
      {
        a: [{ b: "" }],
        c: "",
      },
      {
        a: {
          b: {
            c: {
              d: {
                e: {
                  f: {
                    v: { w: { x: { y: { z: null } } } },
                  },
                },
              },
            },
          },
        },
      },
    ] as const;
    for (const jsonValue of jsonValues) {
      for (let indent = 0; indent < 3; indent++) {
        const json = JSON.stringify(jsonValue, null, indent);
        for (const { name, stream } of makeStreams(json)) {
          let finalValue;
          try {
            for await (const value of parse(stream)) {
              finalValue = value;
            }
          } catch (e) {
            throw new Error(
              `Parsing ${json} streamed with strategy "${name}" and indentation ${indent} resulted in ${
                (e as any)?.stack
              }`,
              { cause: e }
            );
          }
          assert.deepEqual(
            finalValue,
            jsonValue,
            `Parsing ${json} streamed with strategy "${name}" and indentation ${indent}`
          );
        }
      }
    }
  });

  test("partial results", async () => {
    const inputToOutputs = [
      [null, [null]],
      [true, [true]],
      [false, [false]],
      ["abc", ["", "a", "ab", "abc"]],
      [[], [[]]],
      [
        ["a", "b", "c"],
        [
          [],
          [""],
          ["a"],
          ["a", ""],
          ["a", "b"],
          ["a", "b", ""],
          ["a", "b", "c"],
        ],
      ],
      [
        { greeting: "hi!", name: "G" },
        [
          {},
          { greeting: "" },
          { greeting: "h" },
          { greeting: "hi" },
          { greeting: "hi!" },
          { greeting: "hi!", name: "" },
          { greeting: "hi!", name: "G" },
        ],
      ],
      [
        { a: ["a", { b: ["c"] }] },
        [
          {},
          { a: [] },
          { a: [""] },
          { a: ["a"] },
          { a: ["a", {}] },
          { a: ["a", { b: [] }] },
          { a: ["a", { b: [""] }] },
          { a: ["a", { b: ["c"] }] },
        ],
      ],
    ];
    for (const [val, expectedVals] of inputToOutputs) {
      const stringStream = makeStreamOfChunks(JSON.stringify(val), 1);
      const partialValues = await toArray(
        mapStructuralClone(parse(stringStream))
      );
      assert.deepEqual(
        partialValues,
        expectedVals as unknown,
        `Parsing ${JSON.stringify(val)}`
      );
    }
  });
});
