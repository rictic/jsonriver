# jsonriver

Parse JSON incrementally as it streams in, e.g. from a network request or a language model. Gives you a sequence of increasingly complete values.

jsonriver is small, fast, has no dependencies, and uses only standard features of JavaScript so it works in any JS environment.

Usage:

```js
// Richer example at examples/fetch.js
import {parse} from 'jsonriver';

const response = await fetch(`https://jsonplaceholder.typicode.com/posts`);
const postsStream = parse(response.body.pipeThrough(new TextDecoderStream()));
for await (const posts of postsStream) {
  console.log(posts);
}
```

## Incremental Values

What does it mean that we give you a sequence of increasingly complete values? Consider this JSON:

```json
{"name": "Alex", "keys": [1, 20, 300]}
```

If you gave this to jsonriver one byte at a time it would yield this sequence of values:

```json
{}
{"name": ""}
{"name": "A"}
{"name": "Al"}
{"name": "Ale"}
{"name": "Alex"}
{"name": "Alex", "keys": []}
{"name": "Alex", "keys": [1]}
{"name": "Alex", "keys": [1, 20]}
{"name": "Alex", "keys": [1, 20, 300]}
```

## Correctness

The final value yielded by `parse` will be the same as if you had called `JSON.parse` on the entire string. This is tested against the JSONTestSuite, matching JSON.parse's behavior on tests of correct, incorrect, and ambiguous cases.

The `parse` function also matches `JSON.parse`'s behavior for invalid input. If the input stream cannot be parsed as the start of a valid JSON document, then parsing halts and an error is thrown. More precisely, the promise returned by the `next` method on the AsyncIterable rejects with an Error. Likewise if the input stream closes prematurely.

## Invariants

1.  Subsequent versions of a value will have the same type. i.e. we will never
    yield a value as a string and then later replace it with an array.
2.  true, false, null, and numbers are atomic, we don't yield them until
    we have the entire value.
3.  Strings may be replaced with a longer string, with more characters (in
    the JavaScript sense) appended.
4.  Arrays are only modified by either appending new elements, or
    replacing/mutating the element currently at the end.
5.  Objects are only modified by either adding new properties, or
    replacing/mutating the most recently added property.
6.  As a consequence of 1 and 5, we only add a property to an object once we
    have the entire key and enough of the value to know that value's type.

## See also

The built-in JSON.parse is faster (~5x in simple benchmarking) if you don't need streaming.

[stream-json](https://www.npmjs.com/package/stream-json), is larger, more complex, and slower (~10-20x slower in simple benchmarking), but it's much more featureful, and if you only need a subset of the data it can likely be much faster.

## Development

Install dependencies with:

```bash
npm ci
```

Run the test suite with:

```bash
npm test
```

Run the linter with:

```bash
npm run lint
```

And auto-fix most lint issues with:

```bash
npm run lint -- --fix
```
