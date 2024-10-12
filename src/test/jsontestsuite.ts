/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {test, suite} from 'node:test';
import fs from 'node:fs';
import * as path from 'node:path';
import {assertSameAsJsonParse} from './utils.js';

const dirname = path.dirname(new URL(import.meta.url).pathname);
const testDir = path.join(dirname, '../../vendor/JSONTestSuite/test_parsing');
const jsonTestSuiteTests = fs.readdirSync(testDir);

suite('matching JSON.parse', () => {
  for (const testName of jsonTestSuiteTests) {
    test(testName, async () => {
      const json = fs.readFileSync(path.join(testDir, testName), 'utf8');
      const shouldSucceed: boolean | undefined = testName.startsWith('y_')
        ? true
        : testName.startsWith('n_')
          ? false
          : undefined;
      await assertSameAsJsonParse(testName, json, shouldSucceed);
    });
  }
});
