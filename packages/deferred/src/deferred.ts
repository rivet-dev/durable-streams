/**
 * DurableDeferred - Distributed promises that survive process restarts.
 *
 * A DurableDeferred is a write-once promise backed by a durable stream.
 * It can be created on one machine, resolved on another, and awaited
 * from any number of consumers.
 */

import { DurableStream } from "@durable-streams/client"
import { DurableStream as WritableStream } from "@durable-streams/writer"
import {
  AlreadyResolvedError,
  DeferredNotFoundError,
  DeferredTimeoutError,
  deserializeError,
  serializeError,
} from "./error"
import type { Auth, HeadersRecord, ParamsRecord } from "@durable-streams/client"
import type { SerializedError } from "./error"

/**
 * State of a DurableDeferred.
 */
export type DeferredState = `pending` | `resolved` | `rejected`

/**
 * Options for creating a DurableDeferred.
 */
export interface DeferredOptions {
  /**
   * The URL for the deferred stream.
   */
  url: string

  /**
   * Authentication configuration.
   */
  auth?: Auth

  /**
   * Additional headers to include in requests.
   */
  headers?: HeadersRecord

  /**
   * Additional query parameters.
   */
  params?: ParamsRecord

  /**
   * Custom fetch implementation.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Default AbortSignal for operations.
   */
  signal?: AbortSignal
}

/**
 * Options for creating a new deferred.
 */
export interface CreateOptions extends DeferredOptions {
  /**
   * Time-to-live in seconds.
   */
  ttlSeconds?: number

  /**
   * Absolute expiry time (RFC3339 format).
   */
  expiresAt?: string
}

/**
 * The resolved value wrapper stored in the stream.
 */
interface ResolvedValue<T> {
  __deferred_resolved__: true
  value: T
}

/**
 * The rejected value wrapper stored in the stream.
 */
interface RejectedValue {
  __deferred_rejected__: true
  error: SerializedError
}

type StoredValue<T> = ResolvedValue<T> | RejectedValue

function isResolvedValue<T>(value: unknown): value is ResolvedValue<T> {
  if (typeof value !== `object` || value === null) return false
  if (!(`__deferred_resolved__` in value)) return false
  // The __deferred_resolved__ property indicates a resolved value wrapper
  return Boolean((value as ResolvedValue<T>).__deferred_resolved__)
}

function isRejectedValue(value: unknown): value is RejectedValue {
  if (typeof value !== `object` || value === null) return false
  if (!(`__deferred_rejected__` in value)) return false
  // The __deferred_rejected__ property indicates a rejected value wrapper
  return Boolean((value as RejectedValue).__deferred_rejected__)
}

/**
 * DurableDeferred - A distributed, durable promise.
 *
 * Enables single-value promises that survive process restarts with
 * multi-consumer support.
 *
 * @example
 * ```typescript
 * // Producer creates and resolves
 * const deferred = await DurableDeferred.create({
 *   url: "https://streams.example.com/job/123/result"
 * })
 * await deferred.resolve({ status: "complete", data: result })
 *
 * // Consumer awaits (possibly on different machine)
 * const deferred = await DurableDeferred.connect({
 *   url: "https://streams.example.com/job/123/result"
 * })
 * const result = await deferred.value
 * ```
 */
export class DurableDeferred<T = unknown> {
  readonly url: string
  readonly #options: DeferredOptions
  #cachedValue: T | undefined
  #cachedError: Error | undefined
  #cachedState: DeferredState = `pending`
  #valuePromise: Promise<T> | undefined

  private constructor(opts: DeferredOptions) {
    this.url = opts.url
    this.#options = opts
  }

  /**
   * Create a new deferred.
   *
   * Creates the underlying stream if it doesn't exist.
   *
   * @throws {DurableStreamError} if creation fails (e.g., stream already exists)
   */
  static async create<T = unknown>(
    opts: CreateOptions
  ): Promise<DurableDeferred<T>> {
    const deferred = new DurableDeferred<T>(opts)

    // Create the underlying stream
    await WritableStream.create({
      url: opts.url,
      auth: opts.auth,
      headers: opts.headers,
      params: opts.params,
      fetch: opts.fetch,
      signal: opts.signal,
      contentType: `application/json`,
      ttlSeconds: opts.ttlSeconds,
      expiresAt: opts.expiresAt,
    })

    return deferred
  }

  /**
   * Connect to an existing deferred.
   *
   * @throws {DeferredNotFoundError} if the deferred doesn't exist
   */
  static async connect<T = unknown>(
    opts: DeferredOptions
  ): Promise<DurableDeferred<T>> {
    const deferred = new DurableDeferred<T>(opts)

    // Verify the stream exists
    const stream = new DurableStream(opts)
    try {
      await stream.head()
    } catch (e) {
      if (
        e instanceof Error &&
        (e.message.includes(`not found`) || e.message.includes(`404`))
      ) {
        throw new DeferredNotFoundError(opts.url)
      }
      throw e
    }

    return deferred
  }

  /**
   * Resolve the deferred with a value.
   *
   * @throws {AlreadyResolvedError} if the deferred has already been resolved or rejected
   */
  async resolve(value: T): Promise<void> {
    // Check current state first
    const currentState = await this.state()
    if (currentState !== `pending`) {
      throw new AlreadyResolvedError()
    }

    const stored: ResolvedValue<T> = {
      __deferred_resolved__: true,
      value,
    }

    const stream = new WritableStream({
      url: this.url,
      auth: this.#options.auth,
      headers: this.#options.headers,
      params: this.#options.params,
      fetch: this.#options.fetch,
      signal: this.#options.signal,
      contentType: `application/json`,
    })

    await stream.append(stored)

    // Update cache
    this.#cachedValue = value
    this.#cachedState = `resolved`
  }

  /**
   * Reject the deferred with an error.
   *
   * @throws {AlreadyResolvedError} if the deferred has already been resolved or rejected
   */
  async reject(error: Error): Promise<void> {
    // Check current state first
    const currentState = await this.state()
    if (currentState !== `pending`) {
      throw new AlreadyResolvedError()
    }

    const stored: RejectedValue = {
      __deferred_rejected__: true,
      error: serializeError(error),
    }

    const stream = new WritableStream({
      url: this.url,
      auth: this.#options.auth,
      headers: this.#options.headers,
      params: this.#options.params,
      fetch: this.#options.fetch,
      signal: this.#options.signal,
      contentType: `application/json`,
    })

    await stream.append(stored)

    // Update cache
    this.#cachedError = error
    this.#cachedState = `rejected`
  }

  /**
   * Get the value of the deferred.
   *
   * Returns a promise that resolves when the deferred is resolved,
   * or rejects when the deferred is rejected.
   *
   * For pending deferreds, this will wait indefinitely for resolution.
   * Use wait() for timeout support.
   */
  get value(): Promise<T> {
    // Return cached promise if we have one
    if (this.#valuePromise) {
      return this.#valuePromise
    }

    // Return immediately if we have a cached result
    if (this.#cachedState === `resolved`) {
      return Promise.resolve(this.#cachedValue as T)
    }
    if (this.#cachedState === `rejected`) {
      return Promise.reject(this.#cachedError)
    }

    // Create and cache the promise
    this.#valuePromise = this.#waitForValue()
    return this.#valuePromise
  }

  /**
   * Wait for the deferred to be resolved with a timeout.
   *
   * @param timeout Maximum time to wait in milliseconds
   * @throws {DeferredTimeoutError} if the timeout is exceeded
   */
  async wait(timeout: number): Promise<T> {
    // Return immediately if we have a cached result
    if (this.#cachedState === `resolved`) {
      return this.#cachedValue as T
    }
    if (this.#cachedState === `rejected`) {
      throw this.#cachedError
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new DeferredTimeoutError(timeout))
    }, timeout)

    try {
      return await this.#waitForValue(controller.signal)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Get the current state of the deferred without blocking.
   */
  async state(): Promise<DeferredState> {
    // Return cached state if not pending (immutable once set)
    if (this.#cachedState !== `pending`) {
      return this.#cachedState
    }

    // Check the stream for a value
    const stream = new DurableStream({
      url: this.url,
      auth: this.#options.auth,
      headers: this.#options.headers,
      params: this.#options.params,
      fetch: this.#options.fetch,
      signal: this.#options.signal,
    })

    // Read with live: false to just check current state
    for await (const chunk of stream.read({ live: false })) {
      if (chunk.data.length > 0) {
        const storedValue = this.#parseStoredValue(chunk.data)
        if (storedValue) {
          if (isResolvedValue<T>(storedValue)) {
            this.#cachedValue = storedValue.value
            this.#cachedState = `resolved`
            return `resolved`
          }
          if (isRejectedValue(storedValue)) {
            this.#cachedError = deserializeError(storedValue.error)
            this.#cachedState = `rejected`
            return `rejected`
          }
        }
      }
    }

    return `pending`
  }

  /**
   * Check if the deferred exists.
   */
  async exists(): Promise<boolean> {
    const stream = new DurableStream({
      url: this.url,
      auth: this.#options.auth,
      headers: this.#options.headers,
      params: this.#options.params,
      fetch: this.#options.fetch,
      signal: this.#options.signal,
    })

    try {
      await stream.head()
      return true
    } catch (e) {
      if (
        e instanceof Error &&
        (e.message.includes(`not found`) || e.message.includes(`404`))
      ) {
        return false
      }
      throw e
    }
  }

  /**
   * Delete the deferred and its stored value.
   */
  async delete(): Promise<void> {
    const stream = new DurableStream({
      url: this.url,
      auth: this.#options.auth,
      headers: this.#options.headers,
      params: this.#options.params,
      fetch: this.#options.fetch,
      signal: this.#options.signal,
    })

    await stream.delete()

    // Clear cache
    this.#cachedValue = undefined
    this.#cachedError = undefined
    this.#cachedState = `pending`
    this.#valuePromise = undefined
  }

  /**
   * Internal method to wait for the value with optional abort signal.
   */
  async #waitForValue(signal?: AbortSignal): Promise<T> {
    const stream = new DurableStream({
      url: this.url,
      auth: this.#options.auth,
      headers: this.#options.headers,
      params: this.#options.params,
      fetch: this.#options.fetch,
      signal: signal ?? this.#options.signal,
    })

    // Use long-poll to wait for value
    for await (const chunk of stream.read({ live: `long-poll` })) {
      if (signal?.aborted) {
        if (signal.reason instanceof DeferredTimeoutError) {
          throw signal.reason
        }
        throw new Error(`Operation aborted`)
      }

      if (chunk.data.length > 0) {
        const storedValue = this.#parseStoredValue(chunk.data)
        if (storedValue) {
          if (isResolvedValue<T>(storedValue)) {
            this.#cachedValue = storedValue.value
            this.#cachedState = `resolved`
            return storedValue.value
          }
          if (isRejectedValue(storedValue)) {
            const error = deserializeError(storedValue.error)
            this.#cachedError = error
            this.#cachedState = `rejected`
            throw error
          }
        }
      }
    }

    // Stream ended without a value
    // If we were waiting with a timeout, check if it expired
    if (signal?.aborted && signal.reason instanceof DeferredTimeoutError) {
      throw signal.reason
    }
    throw new Error(`Deferred stream ended without a value`)
  }

  /**
   * Parse the stored value from raw bytes.
   * Handles the array wrapping from the writer package.
   */
  #parseStoredValue(data: Uint8Array): StoredValue<T> | null {
    try {
      const text = new TextDecoder().decode(data)
      const parsed = JSON.parse(text) as unknown

      // The writer package wraps values in an array
      // So we might get [{ __deferred_resolved__: true, value: ... }]
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed[0] as StoredValue<T>
      }

      // Or it could be the raw value if stored differently
      return parsed as StoredValue<T>
    } catch {
      return null
    }
  }
}
