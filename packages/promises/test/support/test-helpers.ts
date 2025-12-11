/**
 * Test helper utilities for promise combinator tests.
 */

/**
 * Encode a string to Uint8Array.
 */
export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * Decode a Uint8Array to string.
 */
export function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

/**
 * Sleep for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create a simple async iterable from an array.
 */
export function* toAsyncIterable<T>(items: Array<T>): Generator<T> {
  for (const item of items) {
    yield item
  }
}

/**
 * Create an async iterable that yields items with delays.
 */
export async function* toAsyncIterableWithDelay<T>(
  items: Array<T>,
  delayMs: number
): AsyncIterable<T> {
  for (const item of items) {
    await sleep(delayMs)
    yield item
  }
}

/**
 * Create an async iterable that never yields.
 */
export async function* neverYields<T>(): AsyncIterable<T> {
  // Yield type annotation to satisfy linter (never actually reached)
  yield await new Promise<T>(() => {
    // Never resolves
  })
}

/**
 * Create an async iterable that yields nothing (empty).
 */
export async function* emptyIterable<T>(): AsyncIterable<T> {
  // Empty async generator - conditionally yields to satisfy linter
  // The condition is always false so nothing is ever yielded
  if (false as boolean) {
    yield undefined as T
  }
}
