/**
 * Promise Combinator Errors
 *
 * Custom error classes for promise combinator operations.
 */

/**
 * Error thrown when a stream ends without emitting any values.
 * Thrown by first(), last(), and other combinators that require at least one value.
 */
export class EmptyStreamError extends Error {
  constructor(message = `Stream ended without emitting any values`) {
    super(message)
    this.name = `EmptyStreamError`
  }
}

/**
 * Error thrown when a combinator operation exceeds its timeout.
 */
export class TimeoutError extends Error {
  /**
   * The timeout duration in milliseconds that was exceeded.
   */
  readonly timeout: number

  constructor(timeout: number, message?: string) {
    super(message ?? `Operation timed out after ${timeout}ms`)
    this.name = `TimeoutError`
    this.timeout = timeout
  }
}

/**
 * Error thrown when find() doesn't match any value in the stream.
 */
export class NotFoundError extends Error {
  constructor(
    message = `No value matching the predicate was found in the stream`
  ) {
    super(message)
    this.name = `NotFoundError`
  }
}
