/**
 * DurableDeferred Error Classes
 */

/**
 * Error thrown when attempting to resolve or reject an already-resolved deferred.
 */
export class AlreadyResolvedError extends Error {
  constructor(message = `Deferred has already been resolved or rejected`) {
    super(message)
    this.name = `AlreadyResolvedError`
  }
}

/**
 * Error thrown when a wait() operation times out.
 */
export class DeferredTimeoutError extends Error {
  /**
   * The timeout duration in milliseconds that was exceeded.
   */
  readonly timeout: number

  constructor(timeout: number, message?: string) {
    super(message ?? `Deferred wait timed out after ${timeout}ms`)
    this.name = `DeferredTimeoutError`
    this.timeout = timeout
  }
}

/**
 * Error thrown when attempting to connect to a deferred that doesn't exist.
 */
export class DeferredNotFoundError extends Error {
  constructor(url: string) {
    super(`Deferred not found: ${url}`)
    this.name = `DeferredNotFoundError`
  }
}

/**
 * Serialized error format stored in the stream.
 */
export interface SerializedError {
  __deferred_error__: true
  name: string
  message: string
  stack?: string
}

/**
 * Check if a value is a serialized error.
 */
export function isSerializedError(value: unknown): value is SerializedError {
  if (typeof value !== `object` || value === null) return false
  if (!(`__deferred_error__` in value)) return false
  // The __deferred_error__ property indicates a serialized error
  return Boolean((value as SerializedError).__deferred_error__)
}

/**
 * Serialize an error for storage.
 */
export function serializeError(error: Error): SerializedError {
  return {
    __deferred_error__: true,
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
}

/**
 * Deserialize an error from storage.
 */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name
  if (serialized.stack) {
    error.stack = serialized.stack
  }
  return error
}
