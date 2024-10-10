/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {
  JsonTokenType,
  jsonTokenTypeToString,
  JsonToken,
  tokenize,
} from "./tokenize.js";

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
export function parse(
  stream: AsyncIterable<string>
): AsyncIterableIterator<JsonValue> {
  const parser = new Parser(stream);
  return parser.parse();
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

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
class Parser {
  private readonly tokenBuffer: JsonToken[] = [];
  private readonly stateStack: State[] = [
    { type: StateEnum.Initial, value: undefined },
  ];
  private toplevelValue: JsonValue | undefined;
  private inputComplete = false;
  readonly tokenStream: AsyncIterator<JsonToken[]>;
  constructor(textStream: AsyncIterable<string>) {
    this.tokenStream = tokenize(textStream);
  }

  async expandBuffer() {
    const next = await this.tokenStream.next();
    if (next.done) {
      this.inputComplete = true;
      return;
    }
    // add in reverse order so we can pop off the end
    const tokens = next.value;
    for (let i = tokens.length - 1; i >= 0; i--) {
      this.tokenBuffer.push(tokens[i]!);
    }
  }

  async *parse(): AsyncIterableIterator<JsonValue> {
    await this.expandBuffer();
    while (true) {
      const updated = this.progress();
      if (this.toplevelValue === undefined) {
        throw new Error(
          "Internal error: toplevelValue should not be undefined after at least one call to progress()"
        );
      }
      if (updated) {
        yield this.toplevelValue;
      }
      if (this.stateStack.length === 0) {
        // We're done, we expect no more tokens.
        while (true) {
          if (this.inputComplete && this.tokenBuffer.length === 0) {
            return;
          }
          const finalToken = this.tokenBuffer.at(-1);
          if (finalToken !== undefined) {
            throw new Error(
              `Unexpected trailing content: ${jsonTokenTypeToString(
                finalToken.type
              )}`
            );
          }
          await this.expandBuffer();
        }
      }
      await this.expandBuffer();
    }
  }

  private progress(): boolean {
    let progressed = false;
    while (true) {
      const token = this.tokenBuffer.pop();
      if (token === undefined) {
        break;
      }
      const state = this.stateStack.at(-1);
      if (state === undefined) {
        throw new Error("Unexpected trailing input");
      }
      if (!progressed) {
        switch (token.type) {
          case undefined:
          case JsonTokenType.StringEnd:
          case JsonTokenType.ArrayEnd:
          case JsonTokenType.ObjectEnd:
            break;
          case JsonTokenType.StringStart:
            if (state.type !== StateEnum.InObjectExpectingKey) {
              progressed = true;
            }
            break;
          case JsonTokenType.StringMiddle:
            if (
              this.stateStack.at(-2)?.type !== StateEnum.InObjectExpectingKey
            ) {
              progressed = true;
            }
            break;
          default:
            progressed = true;
        }
      }
      switch (state.type) {
        case StateEnum.Initial: {
          // We never keep the initial state for more than one call to progress.
          this.stateStack.pop();
          this.toplevelValue = this.progressValue(token);
          break;
        }
        case StateEnum.InString: {
          const parentState = this.stateStack.at(-2);
          switch (token.type) {
            case JsonTokenType.StringMiddle:
              state.value += token.value;
              break;
            case JsonTokenType.StringEnd:
              this.stateStack.pop();
              break;
            default:
              throw new Error(
                `Unexpected ${jsonTokenTypeToString(
                  token.type
                )} token in the middle of string starting ${JSON.stringify(
                  state.value
                )}`
              );
          }
          const updatedString = state.value;
          // Strings are immutable, so unusually we have to look up the
          // stack to see what to do with our new string value.
          switch (parentState?.type) {
            case undefined: {
              // Update the toplevel value.
              this.toplevelValue = updatedString;
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
              if (this.stateStack.at(-1) === parentState) {
                this.stateStack.pop();
                this.stateStack.push({
                  type: StateEnum.InObjectExpectingKey,
                  value: object,
                });
              }
              break;
            }
            case StateEnum.InObjectExpectingKey: {
              // If the string finished, progress to InObjectExpectingValue
              if (this.stateStack.at(-1) === parentState) {
                this.stateStack.pop();
                this.stateStack.push({
                  type: StateEnum.InObjectExpectingValue,
                  value: [updatedString, parentState.value],
                });
              }
              break;
            }
            default: {
              throw new Error(
                "Unexpected parent state for string: " + parentState?.type
              );
            }
          }
          break;
        }
        case StateEnum.InArray: {
          switch (token.type) {
            case JsonTokenType.ArrayEnd:
              this.stateStack.pop();
              break;
            default: {
              const value = this.progressValue(token);
              state.value.push(value);
            }
          }
          break;
        }
        case StateEnum.InObjectExpectingKey: {
          switch (token.type) {
            case JsonTokenType.StringStart: {
              this.stateStack.push({
                type: StateEnum.InString,
                value: "",
              });
              break;
            }
            case JsonTokenType.String: {
              this.stateStack.pop();
              this.stateStack.push({
                type: StateEnum.InObjectExpectingValue,
                value: [token.value, state.value],
              });
              break;
            }
            case JsonTokenType.ObjectEnd:
              this.stateStack.pop();
              break;
            default:
              throw new Error(
                `Unexpected ${jsonTokenTypeToString(
                  token.type
                )} token in the middle of object expecting key`
              );
          }
          break;
        }
        case StateEnum.InObjectExpectingValue: {
          switch (token.type) {
            case JsonTokenType.ObjectEnd:
              this.stateStack.pop();
              break;
            default: {
              const [key, object] = state.value;
              if (token.type !== JsonTokenType.StringStart) {
                this.stateStack.pop();
                this.stateStack.push({
                  type: StateEnum.InObjectExpectingKey,
                  value: object,
                });
              }
              const value = this.progressValue(token);
              object[key] = value;
            }
          }
          break;
        }
      }
    }
    return progressed;
  }

  private progressValue(token: JsonToken): JsonValue {
    switch (token.type) {
      case JsonTokenType.Null:
        return null;
      case JsonTokenType.Boolean:
        return token.value;
      case JsonTokenType.Number:
        return token.value;
      case JsonTokenType.String:
        return token.value;
      case JsonTokenType.StringStart: {
        const state: InStringState = { type: StateEnum.InString, value: "" };
        this.stateStack.push(state);
        return "";
      }
      case JsonTokenType.ArrayStart: {
        const state: InArrayState = { type: StateEnum.InArray, value: [] };
        this.stateStack.push(state);
        return state.value;
      }
      case JsonTokenType.ObjectStart:
        const state: InObjectExpectingKeyState = {
          type: StateEnum.InObjectExpectingKey,
          value: {},
        };
        this.stateStack.push(state);
        return state.value;
      default:
        throw new Error(
          "Unexpected token type: " + jsonTokenTypeToString(token.type)
        );
    }
  }
}
