/**
 * @durable-streams/promises
 *
 * Promise combinators for extracting single values from Durable Streams.
 *
 * Inspired by GTOR's taxonomy - bridges plural (streams) to singular (promises).
 *
 * @packageDocumentation
 */

// Combinator functions
export { first, last, take, collect, reduce, find } from "./combinators"

// Types
export type { CombinatorOptions, CollectOptions } from "./combinators"

// Errors
export { EmptyStreamError, TimeoutError, NotFoundError } from "./error"
