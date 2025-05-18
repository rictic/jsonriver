/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {
  JsonTokenType,
  jsonTokenTypeToString,
  Tokenizer,
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
    this.tokenizer = new Tokenizer(textStream, this);
  }

  async next(): Promise<IteratorResult<JsonValue, undefined>> {
    if (this.#finished) {
      return {done: true, value: undefined};
    }
    while (true) {
      while (this.tokenizer.tokenizeMore()) {
        // keep tokenizing while progress can be made synchronously
      }
      if (this.#progressed) {
        this.#progressed = false;
        if (this.#toplevelValue === undefined) {
          throw new Error(
            'Internal error: toplevelValue should not be undefined after at least one token',
          );
        }
        return {done: false, value: this.#toplevelValue};
      }
      if (this.#stateStack.length === 0) {
        await this.tokenizer.input.expectEndOfContent();
        this.#finished = true;
        return {done: true, value: undefined};
      }
      await this.tokenizer.input.tryToExpandBuffer();
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<JsonValue> {
    return this;
  }

  onToken(type: JsonTokenType, value: unknown): void {
    if (!this.#progressed) {
      const state = this.#stateStack.at(-1);
      switch (type) {
        case undefined:
        case JsonTokenType.StringEnd:
        case JsonTokenType.ArrayEnd:
        case JsonTokenType.ObjectEnd:
          break;
        case JsonTokenType.StringStart:
          if (state?.type !== StateEnum.InObjectExpectingKey) {
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
    const state = this.#stateStack.at(-1);
    if (state === undefined) {
      throw new Error('Unexpected trailing input');
    }
    switch (state.type) {
        case StateEnum.Initial: {
          // We never keep the initial state for more than one call to progress.
          this.#stateStack.pop();
          this.#toplevelValue = this.#progressValue(type, value);
          break;
        }
        case StateEnum.InString: {
          const parentState = this.#stateStack.at(-2);
          switch (type) {
            case JsonTokenType.StringMiddle:
              state.value += value as string;
              break;
            case JsonTokenType.StringEnd:
              this.#stateStack.pop();
              break;
            default:
              throw new Error(
                `Unexpected ${jsonTokenTypeToString(
                  type,
                )} token in the middle of string starting ${JSON.stringify(
                  state.value,
                )}`,
              );
          }
          const updatedString = state.value;
          // Strings are immutable, so unusually we have to look up the
          // stack to see what to do with our new string value.
          switch (parentState?.type) {
            case undefined: {
              // Update the toplevel value.
              this.#toplevelValue = updatedString;
              break;
            }
            case StateEnum.InArray: {
              // Overwrite the final element in the array.
              const array = parentState.value;
              array[array.length - 1] = updatedString;
              break;
            }
            case StateEnum.InObjectExpectingValue: {
              const [key, object] = parentState.value;
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
            case StateEnum.InObjectExpectingKey: {
              // If the string finished, progress to InObjectExpectingValue
              if (this.#stateStack.at(-1) === parentState) {
                this.#stateStack.pop();
                this.#stateStack.push({
                  type: StateEnum.InObjectExpectingValue,
                  value: [updatedString, parentState.value],
                });
              }
              break;
            }
            default: {
              throw new Error(
                'Unexpected parent state for string: ' + parentState?.type,
              );
            }
          }
          break;
        }
        case StateEnum.InArray: {
          switch (type) {
            case JsonTokenType.ArrayEnd:
              this.#stateStack.pop();
              break;
            default: {
              const v = this.#progressValue(type, value);
              state.value.push(v);
            }
          }
          break;
        }
        case StateEnum.InObjectExpectingKey: {
          switch (type) {
            case JsonTokenType.StringStart: {
              this.#stateStack.push({
                type: StateEnum.InString,
                value: '',
              });
              break;
            }
            case JsonTokenType.String: {
              this.#stateStack.pop();
              this.#stateStack.push({
                type: StateEnum.InObjectExpectingValue,
                value: [value as string, state.value],
              });
              break;
            }
            case JsonTokenType.ObjectEnd:
              this.#stateStack.pop();
              break;
            default:
              throw new Error(
                `Unexpected ${jsonTokenTypeToString(
                  type,
                )} token in the middle of object expecting key`,
              );
          }
          break;
        }
        case StateEnum.InObjectExpectingValue: {
          switch (type) {
            case JsonTokenType.ObjectEnd:
              this.#stateStack.pop();
              break;
            default: {
              const [key, object] = state.value;
              if (type !== JsonTokenType.StringStart) {
                this.#stateStack.pop();
                this.#stateStack.push({
                  type: StateEnum.InObjectExpectingKey,
                  value: object,
                });
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
