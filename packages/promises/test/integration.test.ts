/**
 * Integration tests for promise combinators with DurableStream.
 *
 * Note: The Durable Streams protocol may batch multiple messages into a single
 * response chunk. These tests verify that the combinators work correctly with
 * the actual stream behavior.
 */

import { describe, expect } from "vitest"
import { DurableStream } from "@durable-streams/client"
import {
  EmptyStreamError,
  NotFoundError,
  collect,
  find,
  first,
  last,
  reduce,
} from "../src/index"
import { testWithTextStream } from "./support/test-context"
import { decode, encode } from "./support/test-helpers"
import type { StreamChunk } from "@durable-streams/client"

// ============================================================================
// Integration with DurableStream
// ============================================================================

describe(`Integration with DurableStream`, () => {
  testWithTextStream(
    `first() should get first chunk from stream`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`hello world`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const result = await first(stream.read({ live: false }))
      expect(decode(result.data)).toBe(`hello world`)
    }
  )

  testWithTextStream(
    `first() should throw EmptyStreamError for empty stream`,
    async ({ streamUrl, aborter }) => {
      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      // Create a custom iterable that filters empty chunks
      async function* nonEmptyChunks(): AsyncIterable<StreamChunk> {
        for await (const chunk of stream.read({ live: false })) {
          if (chunk.data.length > 0) {
            yield chunk
          }
        }
      }

      await expect(first(nonEmptyChunks())).rejects.toThrow(EmptyStreamError)
    }
  )

  testWithTextStream(
    `last() should get last chunk from stream`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`only chunk`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const result = await last(stream.read({ live: false }))
      expect(decode(result.data)).toContain(`only chunk`)
    }
  )

  testWithTextStream(
    `collect() should get all chunks`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`data`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const result = await collect(stream.read({ live: false }))
      // Should have at least one chunk with data
      expect(result.length).toBeGreaterThan(0)
      expect(result.some((c) => decode(c.data).includes(`data`))).toBe(true)
    }
  )

  testWithTextStream(
    `reduce() should aggregate chunk data`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`hello `))
      store.append(streamPath, encode(`world`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const result = await reduce(
        stream.read({ live: false }),
        (acc, chunk) => acc + decode(chunk.data),
        ``
      )
      expect(result).toContain(`hello`)
      expect(result).toContain(`world`)
    }
  )

  testWithTextStream(
    `find() should find chunk matching predicate`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`target data`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      const result = await find(stream.read({ live: false }), (chunk) =>
        decode(chunk.data).includes(`target`)
      )
      expect(decode(result.data)).toContain(`target`)
    }
  )

  testWithTextStream(
    `find() should throw NotFoundError if no match`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`some data`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      await expect(
        find(stream.read({ live: false }), (chunk) =>
          decode(chunk.data).includes(`nonexistent`)
        )
      ).rejects.toThrow(NotFoundError)
    }
  )

  testWithTextStream(
    `combinators work with text() convenience method`,
    async ({ streamUrl, store, streamPath, aborter }) => {
      store.append(streamPath, encode(`text content`))

      const stream = new DurableStream({
        url: streamUrl,
        signal: aborter.signal,
      })

      // text() returns concatenated text for each batch
      const result = await first(stream.text({ live: false }))
      expect(result).toContain(`text content`)
    }
  )
})
