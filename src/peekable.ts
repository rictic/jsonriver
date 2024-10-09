/**
 * @license
 * Copyright Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

/** Adds the ability to look ahead one entry in an AsyncIterableIterator.  */
export class PeekableAsyncIterableIterator<T>
  implements AsyncIterableIterator<T>
{
  private readonly underlying: AsyncIterableIterator<T>;
  private nextValue: Promise<IteratorResult<T>> | null = null;
  constructor(underlying: AsyncIterableIterator<T>) {
    this.underlying = underlying;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
  async next(): Promise<IteratorResult<T>> {
    if (this.nextValue === null) {
      return this.underlying.next();
    }
    const result = this.nextValue;
    this.nextValue = null;
    return result;
  }

  async peek(): Promise<IteratorResult<T>> {
    if (this.nextValue === null) {
      this.nextValue = this.underlying.next();
    }
    return this.nextValue;
  }
}
