/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

const response = await fetch(`../vendor/testdata/small-file.json`);
export const smallJsonString = await response.text();
