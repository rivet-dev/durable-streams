/**
 * Promise Combinators for Durable Streams
 *
 * Simplifies extraction of single values or fixed collections from streams,
 * reducing verbose iteration patterns.
 *
 * Inspired by GTOR's taxonomy of data handling - bridging the gap between
 * plural (streams) and singular (promises) temporal values.
 */

import { EmptyStreamError, NotFoundError, TimeoutError } from "./error"

/**
 * Common options for all combinator methods.
 */
export interface CombinatorOptions {
  /**
   * AbortSignal for cancellation.
   */
  signal?: AbortSignal

  /**
   * Timeout in milliseconds. Throws TimeoutError if exceeded.
   */
  timeout?: number
}

/**
 * Options for collect() method.
 */
export interface CollectOptions extends CombinatorOptions {
  /**
   * Maximum number of items to collect. Throws if exceeded.
   * Defaults to 10,000 for safety.
   */
  maxItems?: number
}

/**
 * Create an abort signal that combines an optional user signal with a timeout.
 * Returns the signal and a cleanup function.
 */
function createTimeoutSignal(
  timeout?: number,
  userSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  if (!timeout && !userSignal) {
    // No timeout or signal - create a never-aborting signal
    const controller = new AbortController()
    return { signal: controller.signal, cleanup: () => {} }
  }

  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  if (timeout) {
    timeoutId = setTimeout(() => {
      controller.abort(new TimeoutError(timeout))
    }, timeout)
  }

  // Link to user signal
  const abortHandler = (): void => {
    if (timeoutId) clearTimeout(timeoutId)
    controller.abort(userSignal?.reason)
  }

  if (userSignal) {
    if (userSignal.aborted) {
      if (timeoutId) clearTimeout(timeoutId)
      controller.abort(userSignal.reason)
    } else {
      userSignal.addEventListener(`abort`, abortHandler, { once: true })
    }
  }

  const cleanup = (): void => {
    if (timeoutId) clearTimeout(timeoutId)
    if (userSignal) {
      userSignal.removeEventListener(`abort`, abortHandler)
    }
  }

  return { signal: controller.signal, cleanup }
}

/**
 * Check if an abort was caused by a timeout.
 */
function isTimeoutAbort(signal: AbortSignal): boolean {
  return signal.reason instanceof TimeoutError
}

/**
 * Get the first value from an async iterable.
 *
 * @throws {EmptyStreamError} if the stream ends without emitting any values
 * @throws {TimeoutError} if the timeout is exceeded
 *
 * @example
 * ```typescript
 * const stream = new DurableStream({ url: "..." })
 * const firstChunk = await first(stream.read({ live: false }))
 * ```
 */
export async function first<T>(
  iterable: AsyncIterable<T>,
  opts?: CombinatorOptions
): Promise<T> {
  const { signal, cleanup } = createTimeoutSignal(opts?.timeout, opts?.signal)

  try {
    for await (const value of iterable) {
      if (signal.aborted) {
        if (isTimeoutAbort(signal)) {
          throw signal.reason
        }
        throw new Error(`Operation aborted`)
      }
      cleanup()
      return value
    }

    throw new EmptyStreamError()
  } finally {
    cleanup()
  }
}

/**
 * Get the last value from an async iterable.
 * Waits for the stream to complete.
 *
 * @throws {EmptyStreamError} if the stream ends without emitting any values
 * @throws {TimeoutError} if the timeout is exceeded
 *
 * @example
 * ```typescript
 * const stream = new DurableStream({ url: "..." })
 * const lastChunk = await last(stream.read({ live: false }))
 * ```
 */
export async function last<T>(
  iterable: AsyncIterable<T>,
  opts?: CombinatorOptions
): Promise<T> {
  const { signal, cleanup } = createTimeoutSignal(opts?.timeout, opts?.signal)

  try {
    let lastValue: T | undefined
    let hasValue = false

    for await (const value of iterable) {
      if (signal.aborted) {
        if (isTimeoutAbort(signal)) {
          throw signal.reason
        }
        throw new Error(`Operation aborted`)
      }
      lastValue = value
      hasValue = true
    }

    if (!hasValue) {
      throw new EmptyStreamError()
    }

    return lastValue as T
  } finally {
    cleanup()
  }
}

/**
 * Take the first n values from an async iterable.
 *
 * @returns An array of up to n values (may be fewer if stream ends early)
 * @throws {TimeoutError} if the timeout is exceeded
 *
 * @example
 * ```typescript
 * const stream = new DurableStream({ url: "..." })
 * const first10 = await take(stream.json({ live: false }), 10)
 * ```
 */
export async function take<T>(
  iterable: AsyncIterable<T>,
  n: number,
  opts?: CombinatorOptions
): Promise<Array<T>> {
  if (n <= 0) {
    return []
  }

  const { signal, cleanup } = createTimeoutSignal(opts?.timeout, opts?.signal)

  try {
    const result: Array<T> = []

    for await (const value of iterable) {
      if (signal.aborted) {
        if (isTimeoutAbort(signal)) {
          throw signal.reason
        }
        throw new Error(`Operation aborted`)
      }

      result.push(value)

      if (result.length >= n) {
        break
      }
    }

    return result
  } finally {
    cleanup()
  }
}

/**
 * Collect all values from an async iterable into an array.
 *
 * @param opts.maxItems Maximum number of items (default: 10,000)
 * @throws {Error} if maxItems is exceeded
 * @throws {TimeoutError} if the timeout is exceeded
 *
 * @example
 * ```typescript
 * const stream = new DurableStream({ url: "..." })
 * const allMessages = await collect(stream.json({ live: false }))
 * ```
 */
export async function collect<T>(
  iterable: AsyncIterable<T>,
  opts?: CollectOptions
): Promise<Array<T>> {
  const maxItems = opts?.maxItems ?? 10_000
  const { signal, cleanup } = createTimeoutSignal(opts?.timeout, opts?.signal)

  try {
    const result: Array<T> = []

    for await (const value of iterable) {
      if (signal.aborted) {
        if (isTimeoutAbort(signal)) {
          throw signal.reason
        }
        throw new Error(`Operation aborted`)
      }

      result.push(value)

      if (result.length > maxItems) {
        throw new Error(
          `Stream exceeded maximum item limit of ${maxItems}. ` +
            `Use the maxItems option to increase the limit.`
        )
      }
    }

    return result
  } finally {
    cleanup()
  }
}

/**
 * Reduce an async iterable to a single accumulated value.
 *
 * @throws {TimeoutError} if the timeout is exceeded
 *
 * @example
 * ```typescript
 * const stream = new DurableStream({ url: "..." })
 * const sum = await reduce(
 *   stream.json<{ value: number }>({ live: false }),
 *   (acc, msg) => acc + msg.value,
 *   0
 * )
 * ```
 */
export async function reduce<T, R>(
  iterable: AsyncIterable<T>,
  reducer: (accumulator: R, value: T, index: number) => R,
  initialValue: R,
  opts?: CombinatorOptions
): Promise<R> {
  const { signal, cleanup } = createTimeoutSignal(opts?.timeout, opts?.signal)

  try {
    let accumulator = initialValue
    let index = 0

    for await (const value of iterable) {
      if (signal.aborted) {
        if (isTimeoutAbort(signal)) {
          throw signal.reason
        }
        throw new Error(`Operation aborted`)
      }

      accumulator = reducer(accumulator, value, index)
      index++
    }

    return accumulator
  } finally {
    cleanup()
  }
}

/**
 * Find the first value matching a predicate in an async iterable.
 *
 * @throws {NotFoundError} if no value matches the predicate
 * @throws {TimeoutError} if the timeout is exceeded
 *
 * @example
 * ```typescript
 * const stream = new DurableStream({ url: "..." })
 * const errorMsg = await find(
 *   stream.json<{ type: string }>({ live: false }),
 *   (msg) => msg.type === "error"
 * )
 * ```
 */
export async function find<T>(
  iterable: AsyncIterable<T>,
  predicate: (value: T, index: number) => boolean | Promise<boolean>,
  opts?: CombinatorOptions
): Promise<T> {
  const { signal, cleanup } = createTimeoutSignal(opts?.timeout, opts?.signal)

  try {
    let index = 0

    for await (const value of iterable) {
      if (signal.aborted) {
        if (isTimeoutAbort(signal)) {
          throw signal.reason
        }
        throw new Error(`Operation aborted`)
      }

      if (await predicate(value, index)) {
        cleanup()
        return value
      }
      index++
    }

    throw new NotFoundError()
  } finally {
    cleanup()
  }
}
