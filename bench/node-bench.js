/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {parse} from './bundles/bundle.min.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dirname = new URL('.', import.meta.url).pathname;
const smallJsonString = fs.readFileSync(
  path.join(dirname, `../vendor/testdata/small-file.json`),
  {encoding: 'utf-8'},
);
const mediumJsonString = fs.readFileSync(
  path.join(dirname, `../vendor/testdata/medium-file.json`),
  {encoding: 'utf-8'},
);
const largeJsonString = fs.readFileSync(
  path.join(dirname, `../vendor/testdata/large-file.json`),
  {encoding: 'utf-8'},
);

async function* toStream(str) {
  yield str;
}

// Parser for the current working directory
async function jsonParseCurrent(jsonString) {
  let finalValue;
  for await (const val of parse(toStream(jsonString))) {
    finalValue = val;
  }
  return finalValue;
}

// Logic to determine the comparison target (main branch or baseline)
let oldJsonRiver;
const mainBranchBundlePath = process.env.MAIN_BRANCH_BUNDLE_PATH;

if (mainBranchBundlePath) {
  const {parse} = await import(path.resolve(mainBranchBundlePath));

  oldJsonRiver = {
    name: 'jsonriver (main branch)',
    parse: async function jsonParseMainBranch(jsonString) {
      let finalValue;
      for await (const val of parse(toStream(jsonString))) {
        finalValue = val;
      }
      return finalValue;
    },
  };
} else {
  const baselineModuleUrl = new URL(
    './bundles/baseline.min.js',
    import.meta.url,
  ).href;
  const {parse} = await import(baselineModuleUrl);
  oldJsonRiver = {
    name: 'jsonriver v0.1',
    parse: async function jsonParseBaseline(jsonString) {
      let finalValue;
      for await (const val of parse(toStream(jsonString))) {
        finalValue = val;
      }
      return finalValue;
    },
  };
}

const comparisons = [
  {
    name: 'jsonriver (current)',
    parse: jsonParseCurrent,
  },
  oldJsonRiver,
  {
    name: 'JSON.parse',
    parse: JSON.parse,
  },
];

async function benchmarkFile(comparisons, str, name, numTimes) {
  const times = [];
  for (const comparison of comparisons) {
    times.push([]);
  }
  for (let i = 0; i < numTimes; i++) {
    for (let j = 0; j < comparisons.length; j++) {
      const start = performance.now();
      await comparisons[j].parse(str);
      times[j].push(performance.now() - start);
    }
  }

  // Report mean and standard deviation
  function mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  function stdDev(arr) {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  }
  console.log(`Parsing ${name} averaged over ${numTimes} runs`);
  for (let i = 0; i < comparisons.length; i++) {
    console.log(
      `  ${comparisons[i].name.padEnd(25, ' ')} ${mean(times[i])
        .toFixed(3)
        .padStart(10, ' ')}ms ±${stdDev(times[i]).toFixed(2)}ms`,
    );
  }
  console.log('\n');
}

await benchmarkFile(
  comparisons,
  smallJsonString,
  'a small file (64KiB)',
  10_000,
);
await benchmarkFile(
  comparisons,
  mediumJsonString,
  'a medium file (1.4MiB)',
  1_000,
);
await benchmarkFile(comparisons, largeJsonString, 'a large file (25MiB)', 20);
