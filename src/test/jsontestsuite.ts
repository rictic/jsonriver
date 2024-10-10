/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import assert from "node:assert/strict";
import { test, suite } from "node:test";
import { parse } from "../index.js";
import fs from "node:fs";
import * as path from "node:path";

async function* makeStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

const dirname = path.dirname(new URL(import.meta.url).pathname);
const testDir = path.join(dirname, "../../vendor/JSONTestSuite/test_parsing");
const jsonTestSuiteTests = fs.readdirSync(testDir);

suite("matching JSON.parse", () => {
  async function emulatedJsonParse(json: string) {
    let finalValue;
    for await (const value of parse(makeStream(json))) {
      finalValue = value;
    }
    return finalValue;
  }
  async function assertBehaviorMatches(name: string, json: string) {
    let expected;
    let expectedError = null;
    try {
      expected = { success: true, value: JSON.parse(json) };
    } catch (e) {
      expected = { success: false };
      expectedError = e;
    }
    let actual;
    let actualError = null;
    try {
      actual = { success: true, value: await emulatedJsonParse(json) };
    } catch (e) {
      actual = { success: false };
      actualError = e;
    }
    assert.deepEqual(
      actual,
      expected,
      `ActualError: ${(actualError as any)?.stack} ExpectedError: ${
        (expectedError as any)?.stack
      }`
    );
    if (name.startsWith("y_")) {
      assert.ok(
        actual.success,
        `Expected ${name} to succeed but it failed with ${expectedError}`
      );
    } else if (name.startsWith("n_")) {
      assert.ok(!actual.success, `Expected ${name} to fail`);
    }
  }

  for (const testName of jsonTestSuiteTests) {
    test(testName, async () => {
      const json = fs.readFileSync(path.join(testDir, testName), "utf8");
      await assertBehaviorMatches(testName, json);
    });
  }
});
