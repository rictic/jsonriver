/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as nodeStream from 'node:stream';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chain} = require('stream-chain');
const {parser} = require('stream-json');
const Asm = require('stream-json/Assembler');

export async function streamJsonParser(str) {
  // create a node stream with just str
  const stream = new nodeStream.Readable();
  stream.push(str);
  stream.push(null);
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const asm = Asm.connectTo(chain([stream, parser()]));
  asm.on('done', (asm) => resolve(asm.current));
  return promise;
}
