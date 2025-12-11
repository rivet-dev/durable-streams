# Promise Extensions for Durable Streams

This document specifies two extensions inspired by [GTOR](https://github.com/kriskowal/gtor) that bring first-class promise semantics to Durable Streams.

## Background: GTOR's Taxonomy

| Dimension            | Singular | Plural   |
| -------------------- | -------- | -------- |
| **Spatial** (sync)   | Value    | Iterable |
| **Temporal** (async) | Promise  | Stream   |

Durable Streams currently occupies the "plural temporal" quadrant. These extensions add:

1. **Promise Combinators** - Bridge from plural→singular (stream→promise)
2. **DurableDeferred** - Native support for singular temporal values (distributed promises)

---

## Part 1: Promise Combinators

### Motivation

Currently, extracting a single value or fixed collection from a stream requires manual iteration:

```typescript
// Current: verbose
const stream = new DurableStream({ url })
let firstValue: T | undefined
for await (const chunk of stream.json<T>()) {
  firstValue = chunk
  break
}
```

Promise combinators provide ergonomic methods that reduce streams to promises.

### API Design

```typescript
class DurableStream {
  // ... existing methods ...

  /**
   * Returns a promise that resolves with the first value from the stream.
   * Rejects if the stream ends without emitting any values.
   *
   * @param opts.signal - AbortSignal to cancel the operation
   * @param opts.timeout - Maximum time to wait in milliseconds
   * @throws {EmptyStreamError} if stream ends with no values
   * @throws {TimeoutError} if timeout exceeded
   * @throws {AbortError} if signal is aborted
   */
  first<T>(opts?: { signal?: AbortSignal; timeout?: number }): Promise<T>

  /**
   * Returns a promise that resolves with the last value from the stream.
   * Waits for the stream to end (requires finite stream or timeout).
   *
   * @param opts.signal - AbortSignal to cancel the operation
   * @param opts.timeout - Maximum time to wait in milliseconds
   * @throws {EmptyStreamError} if stream ends with no values
   * @throws {TimeoutError} if timeout exceeded
   */
  last<T>(opts?: { signal?: AbortSignal; timeout?: number }): Promise<T>

  /**
   * Returns a promise that resolves with an array of the first n values.
   * Resolves early if stream ends before n values.
   *
   * @param n - Maximum number of values to collect
   * @param opts.signal - AbortSignal to cancel the operation
   * @param opts.timeout - Maximum time to wait in milliseconds
   */
  take<T>(
    n: number,
    opts?: {
      signal?: AbortSignal
      timeout?: number
    }
  ): Promise<T[]>

  /**
   * Collects all values into an array.
   * WARNING: Only use with finite streams or with a timeout.
   *
   * @param opts.signal - AbortSignal to cancel the operation
   * @param opts.timeout - Maximum time to wait in milliseconds
   * @param opts.maxItems - Maximum items to collect (safety limit)
   */
  collect<T>(opts?: {
    signal?: AbortSignal
    timeout?: number
    maxItems?: number
  }): Promise<T[]>

  /**
   * Reduces the stream to a single value.
   *
   * @param reducer - Function called with (accumulator, value, index)
   * @param initialValue - Starting value for the accumulator
   * @param opts.signal - AbortSignal to cancel the operation
   * @param opts.timeout - Maximum time to wait in milliseconds
   */
  reduce<T, R>(
    reducer: (acc: R, value: T, index: number) => R,
    initialValue: R,
    opts?: {
      signal?: AbortSignal
      timeout?: number
    }
  ): Promise<R>

  /**
   * Returns a promise that resolves when a value matching the predicate is found.
   *
   * @param predicate - Function that returns true for the desired value
   * @param opts.signal - AbortSignal to cancel the operation
   * @param opts.timeout - Maximum time to wait in milliseconds
   * @throws {NotFoundError} if stream ends without a match
   */
  find<T>(
    predicate: (value: T, index: number) => boolean | Promise<boolean>,
    opts?: {
      signal?: AbortSignal
      timeout?: number
    }
  ): Promise<T>
}
```

### Error Types

```typescript
/**
 * Thrown when a combinator expects values but stream is empty.
 */
export class EmptyStreamError extends DurableStreamError {
  constructor(url: string) {
    super(`Stream at ${url} ended without emitting any values`)
  }
}

/**
 * Thrown when a timeout is exceeded.
 */
export class TimeoutError extends DurableStreamError {
  constructor(timeout: number) {
    super(`Operation timed out after ${timeout}ms`)
  }
}

/**
 * Thrown when find() doesn't match any value.
 */
export class NotFoundError extends DurableStreamError {
  constructor(url: string) {
    super(`No matching value found in stream at ${url}`)
  }
}
```

### Implementation

```typescript
// packages/client/src/combinators.ts

import { DurableStream } from "./stream"
import { EmptyStreamError, TimeoutError, NotFoundError } from "./errors"

export function addCombinators(StreamClass: typeof DurableStream): void {
  StreamClass.prototype.first = async function <T>(
    this: DurableStream,
    opts?: { signal?: AbortSignal; timeout?: number }
  ): Promise<T> {
    const controller = new AbortController()
    const signal = chainSignals(opts?.signal, controller.signal)

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (opts?.timeout) {
      timeoutId = setTimeout(() => controller.abort(), opts.timeout)
    }

    try {
      for await (const value of this.json<T>({ signal, live: false })) {
        controller.abort() // Stop iteration
        return value
      }
      throw new EmptyStreamError(this.url)
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbortError" &&
        opts?.timeout
      ) {
        throw new TimeoutError(opts.timeout)
      }
      throw error
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  StreamClass.prototype.take = async function <T>(
    this: DurableStream,
    n: number,
    opts?: { signal?: AbortSignal; timeout?: number }
  ): Promise<T[]> {
    const controller = new AbortController()
    const signal = chainSignals(opts?.signal, controller.signal)

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (opts?.timeout) {
      timeoutId = setTimeout(() => controller.abort(), opts.timeout)
    }

    const results: T[] = []
    try {
      for await (const value of this.json<T>({ signal, live: false })) {
        results.push(value)
        if (results.length >= n) {
          controller.abort()
          break
        }
      }
      return results
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (results.length > 0) return results
        if (opts?.timeout) throw new TimeoutError(opts.timeout)
      }
      throw error
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  StreamClass.prototype.collect = async function <T>(
    this: DurableStream,
    opts?: { signal?: AbortSignal; timeout?: number; maxItems?: number }
  ): Promise<T[]> {
    const maxItems = opts?.maxItems ?? 10_000 // Safety default
    return this.take<T>(maxItems, opts)
  }

  StreamClass.prototype.reduce = async function <T, R>(
    this: DurableStream,
    reducer: (acc: R, value: T, index: number) => R,
    initialValue: R,
    opts?: { signal?: AbortSignal; timeout?: number }
  ): Promise<R> {
    let acc = initialValue
    let index = 0

    const controller = new AbortController()
    const signal = chainSignals(opts?.signal, controller.signal)

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (opts?.timeout) {
      timeoutId = setTimeout(() => controller.abort(), opts.timeout)
    }

    try {
      for await (const value of this.json<T>({ signal, live: false })) {
        acc = reducer(acc, value, index++)
      }
      return acc
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbortError" &&
        opts?.timeout
      ) {
        throw new TimeoutError(opts.timeout)
      }
      throw error
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  StreamClass.prototype.find = async function <T>(
    this: DurableStream,
    predicate: (value: T, index: number) => boolean | Promise<boolean>,
    opts?: { signal?: AbortSignal; timeout?: number }
  ): Promise<T> {
    const controller = new AbortController()
    const signal = chainSignals(opts?.signal, controller.signal)

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (opts?.timeout) {
      timeoutId = setTimeout(() => controller.abort(), opts.timeout)
    }

    let index = 0
    try {
      for await (const value of this.json<T>({ signal, live: false })) {
        if (await predicate(value, index++)) {
          controller.abort()
          return value
        }
      }
      throw new NotFoundError(this.url)
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbortError" &&
        opts?.timeout
      ) {
        throw new TimeoutError(opts.timeout)
      }
      throw error
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }
}

function chainSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    })
  }
  return controller.signal
}
```

### Usage Examples

```typescript
import { DurableStream } from "@durable-streams/client"

const stream = new DurableStream({ url: "https://streams.example.com/events" })

// Get the first event
const firstEvent = await stream.first<Event>()

// Get the first 10 events
const batch = await stream.take<Event>(10)

// Wait for a specific event (with timeout)
const loginEvent = await stream.find<Event>((e) => e.type === "user.login", {
  timeout: 30_000,
})

// Sum all numbers in a stream
const total = await stream.reduce<number, number>((sum, n) => sum + n, 0, {
  timeout: 5_000,
})

// Collect all events (with safety limit)
const allEvents = await stream.collect<Event>({ maxItems: 1000 })
```

---

## Part 2: DurableDeferred (Single-Value Streams)

### Motivation

Sometimes you need a distributed promise - a single value that:

- Is written once by a producer (anywhere on the network)
- Can be awaited by multiple consumers (anywhere on the network)
- Is durable (survives restarts, can be resumed)
- Supports TTL and expiration

Use cases:

- Job results (submit job, await result from anywhere)
- Request/response over durable infrastructure
- One-shot notifications
- Distributed rendezvous points

### API Design

````typescript
// packages/deferred/src/deferred.ts

export interface DeferredOptions {
  url: string
  auth?: Auth
  headers?: HeadersRecord
  params?: ParamsRecord
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
}

export interface CreateDeferredOptions extends DeferredOptions {
  /** Content type for the resolved value */
  contentType?: string
  /** TTL in seconds */
  ttlSeconds?: number
  /** Absolute expiration time (RFC3339) */
  expiresAt?: string
}

export type DeferredState =
  | { status: "pending" }
  | { status: "resolved"; value: unknown }
  | { status: "rejected"; error: Error }

/**
 * A distributed promise - a single-value durable stream.
 *
 * DurableDeferred represents a value that will be available in the future.
 * Unlike regular promises, it is:
 * - Durable: survives process restarts
 * - Distributed: can be resolved/awaited from different machines
 * - Persistent: the resolved value is stored until TTL expires
 *
 * Internally, uses a durable stream with special semantics:
 * - Exactly one value can be written (resolve/reject)
 * - Multiple readers can await the same value
 * - After resolution, new readers immediately receive the value
 */
export class DurableDeferred<T = unknown> {
  readonly url: string

  private constructor(opts: DeferredOptions)

  /**
   * Create a new deferred value.
   *
   * @example
   * ```typescript
   * const deferred = await DurableDeferred.create({
   *   url: "https://streams.example.com/job-123-result",
   *   contentType: "application/json",
   *   ttlSeconds: 3600, // Keep result for 1 hour
   * })
   * ```
   */
  static create<T>(opts: CreateDeferredOptions): Promise<DurableDeferred<T>>

  /**
   * Connect to an existing deferred.
   * Does not create the deferred if it doesn't exist.
   *
   * @example
   * ```typescript
   * const deferred = DurableDeferred.connect<JobResult>({
   *   url: "https://streams.example.com/job-123-result",
   * })
   * const result = await deferred.value
   * ```
   */
  static connect<T>(opts: DeferredOptions): DurableDeferred<T>

  /**
   * Resolve the deferred with a value.
   * Can only be called once. Subsequent calls throw AlreadyResolvedError.
   *
   * @throws {AlreadyResolvedError} if already resolved/rejected
   * @throws {NotFoundError} if deferred doesn't exist
   */
  resolve(value: T): Promise<void>

  /**
   * Reject the deferred with an error.
   * Can only be called once. Subsequent calls throw AlreadyResolvedError.
   *
   * The error is serialized as JSON: { error: true, message: string, name: string }
   *
   * @throws {AlreadyResolvedError} if already resolved/rejected
   * @throws {NotFoundError} if deferred doesn't exist
   */
  reject(error: Error): Promise<void>

  /**
   * A promise that resolves with the deferred value.
   *
   * - If already resolved: resolves immediately
   * - If pending: waits for resolution (via long-poll or SSE)
   * - If rejected: rejects with the stored error
   *
   * @example
   * ```typescript
   * const result = await deferred.value
   * ```
   */
  readonly value: Promise<T>

  /**
   * Get the current state without waiting.
   *
   * @example
   * ```typescript
   * const state = await deferred.state()
   * if (state.status === "resolved") {
   *   console.log("Already done:", state.value)
   * }
   * ```
   */
  state(): Promise<DeferredState>

  /**
   * Check if the deferred exists.
   */
  exists(): Promise<boolean>

  /**
   * Delete the deferred (and its value if resolved).
   */
  delete(): Promise<void>

  /**
   * Wait for resolution with a timeout.
   *
   * @throws {TimeoutError} if timeout exceeded while pending
   */
  wait(timeout: number): Promise<T>
}
````

### Error Types

```typescript
/**
 * Thrown when trying to resolve/reject an already-settled deferred.
 */
export class AlreadyResolvedError extends DurableStreamError {
  constructor(url: string) {
    super(`Deferred at ${url} has already been resolved or rejected`)
  }
}
```

### Wire Protocol

DurableDeferred uses the existing Durable Streams protocol with conventions:

1. **Create**: `PUT /deferred-url` with optional body (if resolving at creation)
2. **Resolve**: `POST /deferred-url` with the value
3. **Read**: `GET /deferred-url` (long-poll or SSE for pending)
4. **State check**: `HEAD /deferred-url`

**Resolution encoding:**

```typescript
// Resolved value: raw value (JSON for application/json)
{ "result": "success", "data": 42 }

// Rejected value: special envelope
{ "__deferred_error__": true, "name": "ValidationError", "message": "Invalid input" }
```

**Sequence enforcement:**

The deferred uses `Stream-Seq: 0` on resolve/reject. If the stream already has data, the server returns 409 Conflict, which maps to `AlreadyResolvedError`.

### Implementation

```typescript
// packages/deferred/src/deferred.ts

import { DurableStream, FetchError } from "@durable-streams/client"
import { DurableStream as Writer } from "@durable-streams/writer"

const ERROR_MARKER = "__deferred_error__"

interface SerializedError {
  [ERROR_MARKER]: true
  name: string
  message: string
  stack?: string
}

function serializeError(error: Error): SerializedError {
  return {
    [ERROR_MARKER]: true,
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
}

function deserializeError(obj: SerializedError): Error {
  const error = new Error(obj.message)
  error.name = obj.name
  if (obj.stack) error.stack = obj.stack
  return error
}

function isSerializedError(value: unknown): value is SerializedError {
  return (
    typeof value === "object" &&
    value !== null &&
    ERROR_MARKER in value &&
    (value as SerializedError)[ERROR_MARKER] === true
  )
}

export class DurableDeferred<T = unknown> {
  readonly url: string
  private opts: DeferredOptions
  private _valuePromise: Promise<T> | null = null

  private constructor(opts: DeferredOptions) {
    this.url = opts.url
    this.opts = opts
  }

  static async create<T>(
    opts: CreateDeferredOptions
  ): Promise<DurableDeferred<T>> {
    // Create the underlying stream
    await Writer.create({
      url: opts.url,
      contentType: opts.contentType ?? "application/json",
      ttlSeconds: opts.ttlSeconds,
      expiresAt: opts.expiresAt,
      auth: opts.auth,
      headers: opts.headers,
      params: opts.params,
      signal: opts.signal,
      fetch: opts.fetch,
    })

    return new DurableDeferred<T>(opts)
  }

  static connect<T>(opts: DeferredOptions): DurableDeferred<T> {
    return new DurableDeferred<T>(opts)
  }

  async resolve(value: T): Promise<void> {
    const writer = new Writer({
      url: this.url,
      contentType: "application/json",
      ...this.opts,
    })

    try {
      await writer.append(value, { seq: "0" })
    } catch (error) {
      if (error instanceof FetchError && error.status === 409) {
        throw new AlreadyResolvedError(this.url)
      }
      throw error
    }
  }

  async reject(error: Error): Promise<void> {
    const writer = new Writer({
      url: this.url,
      contentType: "application/json",
      ...this.opts,
    })

    try {
      await writer.append(serializeError(error), { seq: "0" })
    } catch (err) {
      if (err instanceof FetchError && (err as FetchError).status === 409) {
        throw new AlreadyResolvedError(this.url)
      }
      throw err
    }
  }

  get value(): Promise<T> {
    if (this._valuePromise) return this._valuePromise

    this._valuePromise = (async () => {
      const stream = new DurableStream({
        url: this.url,
        ...this.opts,
      })

      // Wait for the first (and only) value
      for await (const value of stream.json<T | SerializedError>({
        live: "long-poll",
        signal: this.opts.signal,
      })) {
        if (isSerializedError(value)) {
          throw deserializeError(value)
        }
        return value as T
      }

      // Stream ended without a value (shouldn't happen for valid deferred)
      throw new Error(`Deferred at ${this.url} was deleted before resolution`)
    })()

    return this._valuePromise
  }

  async state(): Promise<DeferredState> {
    const stream = new DurableStream({
      url: this.url,
      ...this.opts,
    })

    // Non-blocking read
    for await (const chunk of stream.read({ live: false })) {
      if (chunk.data.length === 0) {
        return { status: "pending" }
      }

      // Parse the value
      const text = new TextDecoder().decode(chunk.data)
      const value = JSON.parse(text)

      if (isSerializedError(value)) {
        return { status: "rejected", error: deserializeError(value) }
      }

      return { status: "resolved", value }
    }

    return { status: "pending" }
  }

  async exists(): Promise<boolean> {
    const stream = new DurableStream({
      url: this.url,
      ...this.opts,
    })

    try {
      const result = await stream.head()
      return result.exists
    } catch {
      return false
    }
  }

  async delete(): Promise<void> {
    await Writer.delete({ url: this.url, ...this.opts })
    this._valuePromise = null
  }

  async wait(timeout: number): Promise<T> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const stream = new DurableStream({
        url: this.url,
        ...this.opts,
      })

      for await (const value of stream.json<T | SerializedError>({
        live: "long-poll",
        signal: controller.signal,
      })) {
        if (isSerializedError(value)) {
          throw deserializeError(value)
        }
        return value as T
      }

      throw new Error(`Deferred at ${this.url} was deleted before resolution`)
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TimeoutError(timeout)
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
```

### Usage Examples

#### Basic Job Pattern

```typescript
// Worker process: create deferred and return URL to client
async function submitJob(jobData: JobInput): Promise<string> {
  const jobId = crypto.randomUUID()
  const deferred = await DurableDeferred.create<JobResult>({
    url: `https://streams.example.com/jobs/${jobId}/result`,
    ttlSeconds: 3600,
  })

  // Queue the job for processing
  await jobQueue.push({ jobId, data: jobData })

  return deferred.url
}

// Worker: process job and resolve deferred
async function processJob(job: QueuedJob): Promise<void> {
  const deferred = DurableDeferred.connect<JobResult>({
    url: `https://streams.example.com/jobs/${job.jobId}/result`,
  })

  try {
    const result = await doExpensiveWork(job.data)
    await deferred.resolve(result)
  } catch (error) {
    await deferred.reject(error as Error)
  }
}

// Client: await job result (possibly from different machine/process)
async function waitForJob(resultUrl: string): Promise<JobResult> {
  const deferred = DurableDeferred.connect<JobResult>({ url: resultUrl })
  return deferred.wait(60_000) // 1 minute timeout
}
```

#### Distributed Rendezvous

```typescript
// Two processes need to exchange data at a specific point

// Process A
const rendezvous = await DurableDeferred.create<{ a: DataA; b: DataB }>({
  url: "https://streams.example.com/rendezvous/session-123",
})

// ... do work ...
const myData: DataA = await computeDataA()

// Wait for Process B's data
const state = await rendezvous.state()
if (state.status === "resolved") {
  // B already provided data
  const { b } = state.value
  await rendezvous.resolve({ a: myData, b })
}

// Process B (similar logic)
const rendezvous = DurableDeferred.connect<{ a: DataA; b: DataB }>({
  url: "https://streams.example.com/rendezvous/session-123",
})

const myData: DataB = await computeDataB()
const state = await rendezvous.state()
if (state.status === "resolved") {
  const { a } = state.value
  await rendezvous.resolve({ a, b: myData })
}

// Both wait for final value
const { a, b } = await rendezvous.value
```

#### Request/Response Pattern

```typescript
// Server: handle requests via durable streams
async function handleRequest(
  requestId: string,
  request: Request
): Promise<void> {
  const responseDeferred = DurableDeferred.connect<Response>({
    url: `https://streams.example.com/responses/${requestId}`,
  })

  try {
    const response = await processRequest(request)
    await responseDeferred.resolve(response)
  } catch (error) {
    await responseDeferred.reject(error as Error)
  }
}

// Client: make request and await response
async function makeRequest(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID()

  // Create response deferred first
  const responseDeferred = await DurableDeferred.create<Response>({
    url: `https://streams.example.com/responses/${requestId}`,
    ttlSeconds: 300, // 5 minute timeout
  })

  // Send request (could be another stream, queue, etc.)
  await sendRequest(requestId, request)

  // Await response
  return responseDeferred.wait(30_000)
}
```

---

## Package Structure

```
packages/
├── client/           # Read-only client (existing)
│   └── src/
│       ├── stream.ts
│       ├── combinators.ts    # NEW: Promise combinators
│       └── errors.ts         # NEW errors
├── writer/           # Read-write client (existing)
│   └── src/
│       └── writer.ts
└── deferred/         # NEW: DurableDeferred
    ├── package.json
    ├── src/
    │   ├── index.ts
    │   ├── deferred.ts
    │   └── errors.ts
    └── test/
        └── deferred.test.ts
```

### Package Dependencies

```
@durable-streams/deferred
├── @durable-streams/client (for reading)
└── @durable-streams/writer (for resolving)
```

---

## Open Questions

1. **Combinator location**: Should combinators be in `@durable-streams/client` or a separate `@durable-streams/combinators` package?

2. **Live mode for combinators**: Should `first()` support live mode (wait indefinitely for first value)? Current spec uses `live: false`.

3. **DurableDeferred rejection serialization**: Should we support custom error types with instanceof checks? Current spec serializes to plain Error.

4. **Multiple resolve semantics**: Should `resolve()` be idempotent if called with the same value? Current spec throws on any second call.

5. **DurableDeferred.race()**: Should we add a static method to race multiple deferreds?

   ```typescript
   const first = await DurableDeferred.race([deferred1, deferred2, deferred3])
   ```

6. **DurableDeferred.all()**: Should we add Promise.all-like semantics?
   ```typescript
   const [a, b, c] = await DurableDeferred.all([
     deferred1,
     deferred2,
     deferred3,
   ])
   ```
