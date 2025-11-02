/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {
  JsonTokenType,
  jsonTokenTypeToString,
  Tokenizer,
  tokenize,
  TokenHandler,
} from './tokenize.js';

/**
 * Incrementally parses a single JSON value from the given iterable of string
 * chunks.
 *
 * Yields a sequence of increasingly complete JSON values as more of the input
 * can be parsed. The final value yielded will be the same as running JSON.parse
 * on the entire input as a single string. If the input is not valid JSON,
 * throws an error in the same way that JSON.parse would, though the error
 * message is not guaranteed to be the same.
 *
 * When possible (i.e. with objects and arrays), the yielded JSON values will
 * be reused. This means that if you store a reference to a yielded value, it
 * will be updated in place as more of the input is parsed.
 *
 * As with JSON.parse, this throws if non-whitespace trailing content is found.
 *
 * For performance, it parses as much of the string that's synchronously
 * available before yielding. So the sequence of partially-complete values
 * that you'll see will vary based on how the input is grouped into stream
 * chunks.
 *
 * The following invariants will also be maintained:
 *
 * 1.  Subsequent versions of a value will have the same type. i.e. we will
 *     never yield a value as a string and then later replace it with an array
 *     (unless the object has repeated keys, see invariant 7).
 * 2.  true, false, null, and numbers are atomic, we don't yield them until
 *     we have the entire value.
 * 3.  Strings may be replaced with a longer string, with more characters (in
 *     the JavaScript sense) appended.
 * 4.  Arrays are modified only by appending new elements or
 *     replacing/mutating the element currently at the end.
 * 5.  Objects are only modified by either adding new properties, or
 *     replacing/mutating the most recently added property, (except in the case
 *     of repeated keys, see invariant 7).
 * 6.  As a consequence of 1 and 5, we only add a property to an object once we
 *     have the entire key and enough of the value to know that value's type.
 * 7.  If an object has the same key multiple times, later values take
 *     precedence over earlier ones, matching the behavior of JSON.parse. This
 *     may result in changing the type of a value, and setting earlier keys
 *     the object.
 */
export async function* parse(
  stream: AsyncIterable<string>,
  options?: Options,
): AsyncIterableIterator<JsonValue> {
  yield* new Parser(stream, options?.completeCallback);
}

interface Options {
  /**
   * A callback that's called with each value once that value is complete. It
   * will also be given information about the path to each
   * completed value.
  *
  * The calls that jsonriver makes to a `completeCallback` are deterministic,
  * regardless of how the incoming JSON streams in.
   *
   * Formally, a value is complete when jsonriver will not mutate it again, nor
   * replace it with a different value, except for the unusual case of a
   * repeated key in an object (see invariant 7 in the parse() docs).
   *
   * For example, when parsing this JSON:
   * ```json
   *     {"name": "Alex", "keys": [1, 20, 300]}
   * ```
   *
   * The complete callback will be called six times, with the following values:
   *
   * ```js
   *     "Alex"
   *     1
   *     20
   *     300
   *     [1, 20, 300]
   *     {"name": "Alex", "keys": [1, 20, 300]}
   * ```
   *
   * And the path segments would be:
   *
   * ```js
   *     ['name']     // the 'keys' property on a toplevel object
   *     ['keys', 0]  // the 0th item in the array on the 'keys' prop
   *     ['keys', 1]  // the 1st item on that array
   *     ['keys', 2]  // the 2nd
   *     ['keys']     // the 'keys' property is now complete
   *     []           // finally, the toplevel value is complete
   * ```
   */
  completeCallback?: (value: JsonValue, path: Path) => void;
}

/**
 * The path of a complete value inside the toplevel parsed value.
 *
 * Note that Path values may be reused between calls to the complete callback.
 */
interface Path {
  /**
   * Constructs an array of the path to the most recently completed value.
   *
   * This method should be called synchronously when the completeCallback is
   * called, as the segments array is created lazily on demand based on the
   * parser's internal state.
   */
  segments(): Array<string | number>;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;
export type JsonObject = {[key: string]: JsonValue};

function setObjectProperty(object: JsonObject, key: string, value: JsonValue) {
  if (key === '__proto__') {
    Object.defineProperty(object, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    object[key] = value;
  }
}

const enum StateEnum {
  Initial,
  InString,
  InArray,
  InObjectExpectingKey,
  InObjectExpectingValue,
}
type State =
  | InitialState
  | InStringState
  | InArrayState
  | InObjectExpectingKeyState
  | InObjectExpectingValueState;
interface InitialState {
  type: StateEnum.Initial;
  value: undefined;
}
interface InStringState {
  type: StateEnum.InString;
  value: string;
}
interface InArrayState {
  type: StateEnum.InArray;
  value: JsonValue[];
}
interface InObjectExpectingKeyState {
  type: StateEnum.InObjectExpectingKey;
  value: [prevKey: string | undefined, object: JsonObject];
}
interface InObjectExpectingValueState {
  type: StateEnum.InObjectExpectingValue;
  value: [key: string, object: JsonObject];
}

const privateStateStackSymbol = Symbol('stateStack');
class CompleteValueInfo implements Path {
  private readonly [privateStateStackSymbol]: readonly State[];
  constructor(actualStateStack: State[]) {
    this[privateStateStackSymbol] = actualStateStack;
  }

  segments(): Array<string | number> {
    const result = [];
    for (let i = 0; i < this[privateStateStackSymbol].length; i++) {
      const state = this[privateStateStackSymbol][i]!;
      switch (state.type) {
        case StateEnum.InString:
        case StateEnum.Initial:
          throw new Error(
            `path.segments() was called with unexpected parser state. Called asynchronously?`,
          );
        case StateEnum.InObjectExpectingKey:
          if (state.value[0] !== undefined) {
            result.push(state.value[0]);
          }
          continue;
        case StateEnum.InArray:
          result.push(state.value.length - 1);
          continue;
        case StateEnum.InObjectExpectingValue:
          result.push(state.value[0]);
          continue;
        default: {
          const never: never = state;
          throw new Error(`Unexpected state: ${String(never)}`);
        }
      }
    }
    return result;
  }
}

class Parser implements AsyncIterableIterator<JsonValue>, TokenHandler {
  private readonly stateStack: State[] = [
    {type: StateEnum.Initial, value: undefined},
  ];
  private toplevelValue: JsonValue | undefined;
  readonly tokenizer: Tokenizer;
  private finished = false;
  private progressed = false;
  private completeCallback: Options['completeCallback'];
  private readonly completeValueInfo: CompleteValueInfo;

  constructor(
    textStream: AsyncIterable<string>,
    completeCallback?: Options['completeCallback'],
  ) {
    this.completeCallback = completeCallback;
    this.completeValueInfo = new CompleteValueInfo(this.stateStack);
    this.tokenizer = tokenize(textStream, this);
  }

  async next(): Promise<IteratorResult<JsonValue, undefined>> {
    if (this.finished) {
      return {done: true, value: undefined};
    }
    while (true) {
      this.progressed = false;
      await this.tokenizer.pump();
      if (this.toplevelValue === undefined) {
        throw new Error(
          'Internal error: toplevelValue should not be undefined after at least one call to pump()',
        );
      }
      if (this.progressed) {
        return {done: false, value: this.toplevelValue};
      }
      if (this.stateStack.length === 0) {
        await this.tokenizer.pump();
        this.finished = true;
        return {done: true, value: undefined};
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<JsonValue> {
    return this;
  }

  handleNull(): void {
    this.handleValueToken(JsonTokenType.Null, undefined);
  }

  handleBoolean(value: boolean): void {
    this.handleValueToken(JsonTokenType.Boolean, value);
  }

  handleNumber(value: number): void {
    this.handleValueToken(JsonTokenType.Number, value);
  }

  handleStringStart(): void {
    const state = this.currentState();
    if (!this.progressed && state.type !== StateEnum.InObjectExpectingKey) {
      this.progressed = true;
    }
    switch (state.type) {
      case StateEnum.Initial:
        this.stateStack.pop();
        this.toplevelValue = this.progressValue(
          JsonTokenType.StringStart,
          undefined,
        );
        break;
      case StateEnum.InArray: {
        const v = this.progressValue(JsonTokenType.StringStart, undefined);
        state.value.push(v);
        break;
      }
      case StateEnum.InObjectExpectingKey:
        this.stateStack.push({type: StateEnum.InString, value: ''});
        break;
      case StateEnum.InObjectExpectingValue: {
        const [key, object] = state.value;
        const sv = this.progressValue(JsonTokenType.StringStart, undefined);
        setObjectProperty(object, key, sv);
        break;
      }
      case StateEnum.InString:
        throw new Error(
          `Unexpected ${jsonTokenTypeToString(
            JsonTokenType.StringStart,
          )} token in the middle of string starting ${JSON.stringify(state.value)}`,
        );
    }
  }

  handleStringMiddle(value: string): void {
    const state = this.currentState();
    if (!this.progressed) {
      const prev = this.stateStack[this.stateStack.length - 2];
      if (prev?.type !== StateEnum.InObjectExpectingKey) {
        this.progressed = true;
      }
    }
    if (state.type !== StateEnum.InString) {
      throw new Error(
        `Unexpected ${jsonTokenTypeToString(
          JsonTokenType.StringMiddle,
        )} token in the middle of string starting ${JSON.stringify(state.value)}`,
      );
    }
    state.value += value;
    const parentState = this.stateStack[this.stateStack.length - 2];
    this.updateStringParent(state.value, parentState, false);
  }

  handleStringEnd(): void {
    const state = this.currentState();
    if (state.type !== StateEnum.InString) {
      throw new Error(
        `Unexpected ${jsonTokenTypeToString(JsonTokenType.StringEnd)} token in the middle of string starting ${JSON.stringify(state.value)}`,
      );
    }
    this.stateStack.pop();
    const parentState = this.stateStack[this.stateStack.length - 1];
    this.updateStringParent(state.value, parentState, true);
  }

  handleArrayStart(): void {
    this.handleValueToken(JsonTokenType.ArrayStart, undefined);
  }

  handleArrayEnd(): void {
    const state = this.currentState();
    if (state.type !== StateEnum.InArray) {
      throw new Error(
        `Unexpected ${jsonTokenTypeToString(JsonTokenType.ArrayEnd)} token`,
      );
    }
    this.stateStack.pop();
    if (this.completeCallback !== undefined) {
      this.completeCallback(state.value, this.completeValueInfo);
    }
  }

  handleObjectStart(): void {
    this.handleValueToken(JsonTokenType.ObjectStart, undefined);
  }

  handleObjectEnd(): void {
    const state = this.currentState();
    switch (state.type) {
      case StateEnum.InObjectExpectingKey:
      case StateEnum.InObjectExpectingValue:
        this.stateStack.pop();
        if (this.completeCallback !== undefined) {
          this.completeCallback(state.value[1], this.completeValueInfo);
        }
        break;
      default:
        throw new Error(
          `Unexpected ${jsonTokenTypeToString(JsonTokenType.ObjectEnd)} token`,
        );
    }
  }

  private currentState(): State {
    const state = this.stateStack[this.stateStack.length - 1];
    if (state === undefined) {
      throw new Error('Unexpected trailing input');
    }
    return state;
  }

  private handleValueToken(type: JsonTokenType, value: unknown): void {
    const state = this.currentState();
    if (!this.progressed) {
      this.progressed = true;
    }
    switch (state.type) {
      case StateEnum.Initial:
        this.stateStack.pop();
        this.toplevelValue = this.progressValue(type, value);
        if (
          this.completeCallback !== undefined &&
          this.stateStack.length === 0
        ) {
          this.completeCallback(this.toplevelValue, this.completeValueInfo);
        }
        break;
      case StateEnum.InArray: {
        const v = this.progressValue(type, value);
        state.value.push(v);
        if (
          this.completeCallback !== undefined &&
          this.stateStack[this.stateStack.length - 1] === state
        ) {
          this.completeCallback(v, this.completeValueInfo);
        }
        break;
      }
      case StateEnum.InObjectExpectingValue: {
        const [key, object] = state.value;
        let expectedState: State = state;
        if (type !== JsonTokenType.StringStart) {
          this.stateStack.pop();
          expectedState = {
            type: StateEnum.InObjectExpectingKey,
            value: [key, object],
          };
          this.stateStack.push(expectedState);
        }
        const v = this.progressValue(type, value);
        setObjectProperty(object, key, v);
        if (
          this.completeCallback !== undefined &&
          this.stateStack[this.stateStack.length - 1] === expectedState
        ) {
          this.completeCallback(v, this.completeValueInfo);
        }
        break;
      }
      case StateEnum.InString:
        throw new Error(
          `Unexpected ${jsonTokenTypeToString(type)} token in the middle of string starting ${JSON.stringify(state.value)}`,
        );
      case StateEnum.InObjectExpectingKey:
        throw new Error(
          `Unexpected ${jsonTokenTypeToString(type)} token in the middle of object expecting key`,
        );
    }
  }

  private updateStringParent(
    updated: string,
    parentState: State | undefined,
    isFinal: boolean,
  ): void {
    switch (parentState?.type) {
      case undefined:
        this.toplevelValue = updated;
        if (isFinal && this.completeCallback !== undefined) {
          this.completeCallback(updated, this.completeValueInfo);
        }
        break;
      case StateEnum.InArray:
        parentState.value[parentState.value.length - 1] = updated;
        if (isFinal && this.completeCallback !== undefined) {
          this.completeCallback(updated, this.completeValueInfo);
        }
        break;
      case StateEnum.InObjectExpectingValue: {
        const [key, object] = parentState.value;
        setObjectProperty(object, key, updated);
        if (isFinal && this.completeCallback !== undefined) {
          this.completeCallback(updated, this.completeValueInfo);
        }
        if (this.stateStack[this.stateStack.length - 1] === parentState) {
          this.stateStack.pop();
          this.stateStack.push({
            type: StateEnum.InObjectExpectingKey,
            value: [key, object],
          });
        }
        break;
      }
      case StateEnum.InObjectExpectingKey:
        if (this.stateStack[this.stateStack.length - 1] === parentState) {
          this.stateStack.pop();
          this.stateStack.push({
            type: StateEnum.InObjectExpectingValue,
            value: [updated, parentState.value[1]],
          });
        }
        break;
      default:
        throw new Error(
          'Unexpected parent state for string: ' + parentState?.type,
        );
    }
  }

  private progressValue(type: JsonTokenType, value: unknown): JsonValue {
    switch (type) {
      case JsonTokenType.Null:
        return null;
      case JsonTokenType.Boolean:
        return value as boolean;
      case JsonTokenType.Number:
        return value as number;
      case JsonTokenType.StringStart: {
        const state: InStringState = {type: StateEnum.InString, value: ''};
        this.stateStack.push(state);
        return '';
      }
      case JsonTokenType.ArrayStart: {
        const state: InArrayState = {type: StateEnum.InArray, value: []};
        this.stateStack.push(state);
        return state.value;
      }
      case JsonTokenType.ObjectStart: {
        const state: InObjectExpectingKeyState = {
          type: StateEnum.InObjectExpectingKey,
          value: [undefined, {}],
        };
        this.stateStack.push(state);
        return state.value[1];
      }
      default:
        throw new Error(
          'Unexpected token type: ' + jsonTokenTypeToString(type),
        );
    }
  }
}
