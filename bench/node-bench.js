// Building stream-json such that it runs in the browser is a pain,
// it depends on a bunch of Node built-ins and the like, so just doing a
// simple microbenchmark here.

import { streamJsonParser } from "./stream-json.js";
import { parse } from "./bundles/bundle.min.js";
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

async function benchmarkFile(str, name, times) {
  const streamJsonTimes = [];
  const jsonRiverTimes = [];
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    await jsonParse(str);
    jsonRiverTimes.push(performance.now() - start);
    const start2 = performance.now();
    await streamJsonParser(str);
    streamJsonTimes.push(performance.now() - start2);
  }

  // Report mean and standard deviation
  function mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  function stdDev(arr) {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  }
  console.log(`Stats from parsing ${name} averaged over ${times} runs`);
  console.log(
    `  jsonriver       ${mean(jsonRiverTimes)
      .toFixed(3)
      .padStart(10, " ")}ms ±${stdDev(jsonRiverTimes).toFixed(2)}ms`
  );
  console.log(
    `  stream-json     ${mean(streamJsonTimes)
      .toFixed(3)
      .padStart(10, " ")}ms ±${stdDev(streamJsonTimes).toFixed(2)}ms`
  );
  console.log("\n");
}

await benchmarkFile(smallJsonString, "a small file (64KiB)", 100);
await benchmarkFile(mediumJsonString, "a medium file (1.4MiB)", 100);
await benchmarkFile(largeJsonString, "a large file (25MiB)", 3);
