/**
 * @durable-streams/deferred
 *
 * Distributed promises that survive process restarts.
 *
 * DurableDeferred enables single-value promises with write-once semantics,
 * durable persistence, and multi-reader support across different machines.
 *
 * @packageDocumentation
 */

// Main class
export { DurableDeferred } from "./deferred"

// Types
export type { DeferredState, DeferredOptions, CreateOptions } from "./deferred"

// Errors
export {
  AlreadyResolvedError,
  DeferredTimeoutError,
  DeferredNotFoundError,
} from "./error"
