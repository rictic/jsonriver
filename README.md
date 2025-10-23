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
    yield a value as a string and then later replace it with an array (unless
    the object has repeated keys, see invariant 7).
2.  true, false, null, and numbers are atomic, we don't yield them until
    we have the entire value.
3.  Strings may be replaced with a longer string, with more characters (in
    the JavaScript sense) appended.
4.  Arrays are only modified by either appending new elements, or
    replacing/mutating the element currently at the end.
5.  Objects are only modified by either adding new properties, or
    replacing/mutating the most recently added property, (except in the case of
    repeated keys, see invariant 7).
6.  As a consequence of 1 and 5, we only add a property to an object once we
    have the entire key and enough of the value to know that value's type.
7.  If an object has the same key multiple times, later values take precedence
    over earlier ones, matching the behavior of JSON.parse. This may result in
    changing the type of a value, and mutating earlier keys in the object.

## Complete Values

The parse function takes an optional set of options object as its second parameter. If the options object has a `completeCallback` function, that function will be called like `completeCallback(value, path)` each time the parser has finished with a value. Given the json:

```json
{"name": "Alex", "keys": [1, 20, 300]}
```

`completeCallback` will be called six times, with the following values:

```js
'Alex'
1
20
300
[1, 20, 300]
{"name": "Alex", "keys": [1, 20, 300]}
```

It is also given a `path`, describing where the newly complete value is in relation to the toplevel parsed value. So for the above example, the paths are:

```js
['name']     // `'Alex'` is in the 'keys' property on a toplevel object
['keys', 0]  // `1` is at index 0 in the array on the 'keys' prop
['keys', 1]  // `20` is at index 1 on that array
['keys', 2]  // `300` is at 2
['keys']     // the array is complete, and found on the 'keys' property
[]           // finally, the toplevel object is complete
```

This information is constructed lazily, so that you only pay for it if you use it. As a result, `completeCallback` must call `path.segments()` synchronously.

### Completions Recipe

A simple and low overhead way to handle completion is with a WeakMap:

```js
const completed = new WeakMap();
function markCompleted(value) {
  if (value && typeof value === 'object') {
    completed.set(value, true);
  }
}
function isComplete(value) {
  if (value && typeof value === 'object') {
    return completed.has(value);
  }
}

const values = parse(stream, {completeCallback: markCompleted});
for await (const value of values) {
  // the render function can use the isComplete function to check whether
  // an object or array is complete
  render(value, isComplete);
}
```

## See also

The built-in JSON.parse is faster (~5x in simple benchmarking) if you don't need streaming.

[stream-json](https://www.npmjs.com/package/stream-json), is larger, more complex, and slower (~10-20x slower in simple benchmarking), but it's much more featureful, and if you only need a subset of the data may be faster.

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
