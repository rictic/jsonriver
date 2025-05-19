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
 * 1. Future versions of a value will have the same type. i.e. we will never
 *    yield a value as a string and then later replace it with an array.
 * 2. true, false, null, and numbers are atomic, we don't yield them until
 *    we have the entire value.
 * 3. Strings may be replaced with a longer string, with more characters (in
 *    the JavaScript sense) appended.
 * 4. Arrays are only modified by either appending new elements, or
 *    replacing/mutating the element currently at the end.
 * 5. Objects are only modified by either adding new properties, or
 *    replacing/mutating the most recently added property.
 * 6. As a consequence of 1 and 5, we only add a property to an object once we
 *    have the entire key and enough of the value to know that value's type.
 */
export async function* parse(
  stream: AsyncIterable<string>,
): AsyncIterableIterator<JsonValue> {
  yield* new Parser(stream);
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;
export type JsonObject = {[key: string]: JsonValue};

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
  value: JsonObject;
}
interface InObjectExpectingValueState {
  type: StateEnum.InObjectExpectingValue;
  value: [key: string, object: JsonObject];
}
class Parser implements AsyncIterableIterator<JsonValue>, TokenHandler {
  readonly #stateStack: State[] = [{type: StateEnum.Initial, value: undefined}];
  #toplevelValue: JsonValue | undefined;
  readonly tokenizer: Tokenizer;
  #finished = false;
  #progressed = false;

  constructor(textStream: AsyncIterable<string>) {
    this.tokenizer = tokenize(textStream, this);
  }

  async next(): Promise<IteratorResult<JsonValue, undefined>> {
    if (this.#finished) {
      return {done: true, value: undefined};
    }
    while (true) {
      this.#progressed = false;
      await this.tokenizer.pump();
      if (this.#toplevelValue === undefined) {
        throw new Error(
          'Internal error: toplevelValue should not be undefined after at least one call to pump()',
        );
      }
      if (this.#progressed) {
        return {done: false, value: this.#toplevelValue};
      }
      if (this.#stateStack.length === 0) {
        await this.tokenizer.pump();
        this.#finished = true;
        return {done: true, value: undefined};
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<JsonValue> {
    return this;
  }

  handleToken(type: JsonTokenType, value: unknown): void {
    const state = this.#stateStack.at(-1);
    if (state === undefined) {
      throw new Error('Unexpected trailing input');
    }

    if (!this.#progressed) {
      switch (type) {
        case JsonTokenType.StringEnd:
        case JsonTokenType.ArrayEnd:
        case JsonTokenType.ObjectEnd:
          break;
        case JsonTokenType.StringStart:
          if (state.type !== StateEnum.InObjectExpectingKey) {
            this.#progressed = true;
          }
          break;
        case JsonTokenType.StringMiddle:
          if (this.#stateStack.at(-2)?.type !== StateEnum.InObjectExpectingKey) {
            this.#progressed = true;
          }
          break;
        default:
          this.#progressed = true;
      }
    }

    switch (state.type) {
      case StateEnum.Initial:
        this.#stateStack.pop();
        this.#toplevelValue = this.#progressValue(type, value);
        break;
      case StateEnum.InString: {
        const parentState = this.#stateStack.at(-2);
        if (type === JsonTokenType.StringMiddle) {
          (state as InStringState).value += value as string;
        } else if (type === JsonTokenType.StringEnd) {
          this.#stateStack.pop();
        } else {
          throw new Error(
            `Unexpected ${jsonTokenTypeToString(type)} token in the middle of string starting ${JSON.stringify((state as InStringState).value)}`,
          );
        }
        const updatedString = (state as InStringState).value;
        switch (parentState?.type) {
          case undefined:
            this.#toplevelValue = updatedString;
            break;
          case StateEnum.InArray:
            (parentState as InArrayState).value[(parentState as InArrayState).value.length - 1] = updatedString;
            break;
          case StateEnum.InObjectExpectingValue: {
            const [key, object] = (parentState as InObjectExpectingValueState).value;
            object[key] = updatedString;
            if (this.#stateStack.at(-1) === parentState) {
              this.#stateStack.pop();
              this.#stateStack.push({
                type: StateEnum.InObjectExpectingKey,
                value: object,
              });
            }
            break;
          }
          case StateEnum.InObjectExpectingKey:
            if (this.#stateStack.at(-1) === parentState) {
              this.#stateStack.pop();
              this.#stateStack.push({
                type: StateEnum.InObjectExpectingValue,
                value: [updatedString, parentState.value],
              });
            }
            break;
          default:
            throw new Error('Unexpected parent state for string: ' + parentState?.type);
        }
        break;
      }
      case StateEnum.InArray:
        if (type === JsonTokenType.ArrayEnd) {
          this.#stateStack.pop();
        } else {
          const v = this.#progressValue(type, value);
          (state as InArrayState).value.push(v);
        }
        break;
      case StateEnum.InObjectExpectingKey:
        switch (type) {
          case JsonTokenType.StringStart:
            this.#stateStack.push({type: StateEnum.InString, value: ''});
            break;
          case JsonTokenType.String:
            this.#stateStack.pop();
            this.#stateStack.push({
              type: StateEnum.InObjectExpectingValue,
              value: [value as string, (state as InObjectExpectingKeyState).value],
            });
            break;
          case JsonTokenType.ObjectEnd:
            this.#stateStack.pop();
            break;
          default:
            throw new Error(
              `Unexpected ${jsonTokenTypeToString(type)} token in the middle of object expecting key`,
            );
        }
        break;
      case StateEnum.InObjectExpectingValue: {
        switch (type) {
          case JsonTokenType.ObjectEnd:
            this.#stateStack.pop();
            break;
          default: {
            const [key, object] = (state as InObjectExpectingValueState).value;
            if (type !== JsonTokenType.StringStart) {
              this.#stateStack.pop();
              this.#stateStack.push({type: StateEnum.InObjectExpectingKey, value: object});
            }
            const v = this.#progressValue(type, value);
            object[key] = v;
          }
        }
        break;
      }
    }
  }

  #progressValue(type: JsonTokenType, value: unknown): JsonValue {
    switch (type) {
      case JsonTokenType.Null:
        return null;
      case JsonTokenType.Boolean:
        return value as boolean;
      case JsonTokenType.Number:
        return value as number;
      case JsonTokenType.String:
        return value as string;
      case JsonTokenType.StringStart: {
        const state: InStringState = {type: StateEnum.InString, value: ''};
        this.#stateStack.push(state);
        return '';
      }
      case JsonTokenType.ArrayStart: {
        const state: InArrayState = {type: StateEnum.InArray, value: []};
        this.#stateStack.push(state);
        return state.value;
      }
      case JsonTokenType.ObjectStart: {
        const state: InObjectExpectingKeyState = {
          type: StateEnum.InObjectExpectingKey,
          value: {},
        };
        this.#stateStack.push(state);
        return state.value;
      }
      default:
        throw new Error(
          'Unexpected token type: ' + jsonTokenTypeToString(type),
        );
    }
  }
}
