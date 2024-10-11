/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

// Building stream-json such that it runs in the browser is a pain,
// it depends on a bunch of Node built-ins and the like, so just doing a
// simple microbenchmark here.

import { streamJsonParser } from "./stream-json.js";
import { parse } from "./bundles/bundle.min.js";
import { parse as unoptimizedParse } from "./bundles/baseline.min.js";
import * as fs from "node:fs";
import * as path from "node:path";

const dirname = new URL(".", import.meta.url).pathname;
const smallJsonString = fs.readFileSync(
  path.join(dirname, `../vendor/testdata/small-file.json`),
  { encoding: "utf-8" }
);
const mediumJsonString = fs.readFileSync(
  path.join(dirname, `../vendor/testdata/medium-file.json`),
  { encoding: "utf-8" }
);
const largeJsonString = fs.readFileSync(
  path.join(dirname, `../vendor/testdata/large-file.json`),
  { encoding: "utf-8" }
);

async function* toStream(str) {
  yield str;
}
async function jsonParse(jsonString) {
  let finalValue;
  for await (const val of parse(toStream(jsonString))) {
    finalValue = val;
  }
  return finalValue;
}
async function jsonParseOld(jsonString) {
  let finalValue;
  for await (const val of unoptimizedParse(toStream(jsonString))) {
    finalValue = val;
  }
  return finalValue;
}

const comparisons = [
  {
    name: "jsonriver",
    parse: jsonParse,
  },
  {
    name: "jsonriver v0.1",
    parse: jsonParseOld,
  },
  {
    name: "stream-json",
    parse: streamJsonParser,
  },
  {
    name: "JSON.parse",
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
      `  ${comparisons[i].name.padEnd(15, " ")} ${mean(times[i])
        .toFixed(3)
        .padStart(10, " ")}ms ±${stdDev(times[i]).toFixed(2)}ms`
    );
  }
  console.log("\n");
}

await benchmarkFile(comparisons, smallJsonString, "a small file (64KiB)", 100);
await benchmarkFile(
  comparisons,
  mediumJsonString,
  "a medium file (1.4MiB)",
  100
);
await benchmarkFile(comparisons, largeJsonString, "a large file (25MiB)", 3);
