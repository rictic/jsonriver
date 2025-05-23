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
  private readonly stateStack: State[] = [
    {type: StateEnum.Initial, value: undefined},
  ];
  private toplevelValue: JsonValue | undefined;
  readonly tokenizer: Tokenizer;
  private finished = false;
  private progressed = false;

  constructor(textStream: AsyncIterable<string>) {
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
        object[key] = sv;
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
    this.updateStringParent(state.value, parentState);
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
    this.updateStringParent(state.value, parentState);
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
        break;
      case StateEnum.InArray: {
        const v = this.progressValue(type, value);
        state.value.push(v);
        break;
      }
      case StateEnum.InObjectExpectingValue: {
        const [key, object] = state.value;
        if (type !== JsonTokenType.StringStart) {
          this.stateStack.pop();
          this.stateStack.push({
            type: StateEnum.InObjectExpectingKey,
            value: object,
          });
        }
        const v = this.progressValue(type, value);
        object[key] = v;
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
  ): void {
    switch (parentState?.type) {
      case undefined:
        this.toplevelValue = updated;
        break;
      case StateEnum.InArray:
        parentState.value[parentState.value.length - 1] = updated;
        break;
      case StateEnum.InObjectExpectingValue: {
        const [key, object] = parentState.value;
        object[key] = updated;
        if (this.stateStack[this.stateStack.length - 1] === parentState) {
          this.stateStack.pop();
          this.stateStack.push({
            type: StateEnum.InObjectExpectingKey,
            value: object,
          });
        }
        break;
      }
      case StateEnum.InObjectExpectingKey:
        if (this.stateStack[this.stateStack.length - 1] === parentState) {
          this.stateStack.pop();
          this.stateStack.push({
            type: StateEnum.InObjectExpectingValue,
            value: [updated, parentState.value],
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
          value: {},
        };
        this.stateStack.push(state);
        return state.value;
      }
      default:
        throw new Error(
          'Unexpected token type: ' + jsonTokenTypeToString(type),
        );
    }
  }
}
