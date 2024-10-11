# jsonriver

Parse JSON incrementally as it streams in, e.g. from a network request or a language model. Gives you a sequence of increasingly complete values.

jsonriver is small, fast, has no dependencies, and uses only standard features so it should run in any JS environment that supports ES2022 or above including browsers, NodeJS, bun, deno, etc.

Usage:

```js
// Full example at examples/fetch.js
import { parse } from "jsonriver";

const response = await fetch(`https://jsonplaceholder.typicode.com/posts`);
const vals = parse(response.body);
for await (const val of vals) {
  renderer.render(posts);
}
```

## Correctness

The final value given by `parse` will be the same as if you had called `JSON.parse` on the entire string. This is tested against the JSONTestSuite, matching JSON.parse's behavior on tests of correct, incorrect, and ambiguous cases.

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

[stream-json](https://www.npmjs.com/package/stream-json), which is more featureful and more complex. jsonriver is simpler and smaller.
