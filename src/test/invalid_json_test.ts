/**
 * Additional invalid JSON cases to ensure parser rejects them just like JSON.parse
 */

import {test, suite} from 'node:test';
import {assertSameAsJsonParse} from './utils.js';

const cases: Array<[string, string]> = [
  ['unclosed array', '[1, 2'],
  ['unclosed object', '{"a": 1'],
  ['missing comma in array', '[1 2]'],
  ['missing comma in object', '{"a": 1 "b": 2}'],
  ['trailing comma in array', '[1, 2,]'],
  ['trailing comma in object', '{"a": 1,}'],
  ['double comma in array', '[1,,2]'],
  ['double comma in object', '{"a": 1,, "b": 2}'],
  ['missing value in object', '{"a": }'],
  ['missing colon in object', '{"a" 1}'],
  ['colon inside array', '["a": 1]'],
  ['unquoted key', '{a: 1}'],
  ['single quoted string', "'abc'"],
  [
    'unescaped newline in string',
    `"hello
world"`,
  ],
  ['invalid escape sequence', '"\\x20"'],
  ['short unicode escape', '"\\u123"'],
  ['bad unicode escape', '"\\uzzzz"'],
  ['leading zero', '01'],
  ['hexadecimal number', '0x1'],
  ['trailing decimal point', '1.'],
  ['leading decimal point', '.1'],
  ['incomplete exponent', '1e'],
  ['sign without exponent digits', '1e+'],
  ['double minus', '--1'],
  ['multiple top-level values', '{"a":1}{"b":2}'],
  ['extra bracket', '[1,2]]'],
  ['trailing characters', '[true, false] garbage'],
  ['number followed by NBSP', '1\u00A0'],
  ['NBSP before value', '\u00A0true'],
  ['NBSP in array before value', '[\u00A01]'],
  ['NBSP in array after value', '[1\u00A0]'],
  ['NBSP in array between values', '[1,\u00A02]'],
  ['NBSP in object before key', '{\u00A0"a": 1}'],
  ['NBSP in object after key', '{"a"\u00A0: 1}'],
  ['NBSP in object before value', '{"a":\u00A01}'],
  ['NBSP in object after value', '{"a": 1\u00A0}'],
  ['NBSP in object between properties', '{"a": 1,\u00A0"b": 2}'],
];

suite('invalid JSON strings', () => {
  for (const [name, json] of cases) {
    test(name, async () => {
      await assertSameAsJsonParse(name, json, false);
    });
  }
});
