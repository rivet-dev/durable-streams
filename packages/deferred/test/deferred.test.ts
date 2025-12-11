/**
 * Tests for DurableDeferred.
 */

import { describe, expect } from "vitest"
import {
  AlreadyResolvedError,
  DeferredNotFoundError,
  DeferredTimeoutError,
  DurableDeferred,
} from "../src/index"
import { testWithServer } from "./support/test-context"
import { sleep } from "./support/test-helpers"

// ============================================================================
// Creation and Connection
// ============================================================================

describe(`DurableDeferred Creation and Connection`, () => {
  testWithServer(
    `should create a new deferred`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-${Date.now()}`

      const deferred = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      expect(deferred.url).toBe(deferredUrl)
      expect(await deferred.exists()).toBe(true)
      expect(await deferred.state()).toBe(`pending`)
    }
  )

  testWithServer(`should create with TTL`, async ({ baseUrl, aborter }) => {
    const deferredUrl = `${baseUrl}/deferred-ttl-${Date.now()}`

    const deferred = await DurableDeferred.create({
      url: deferredUrl,
      ttlSeconds: 3600,
      signal: aborter.signal,
    })

    expect(await deferred.exists()).toBe(true)
  })

  testWithServer(
    `should connect to existing deferred`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-connect-${Date.now()}`

      // Create first
      await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      // Connect
      const connected = await DurableDeferred.connect({
        url: deferredUrl,
        signal: aborter.signal,
      })

      expect(connected.url).toBe(deferredUrl)
      expect(await connected.exists()).toBe(true)
    }
  )

  testWithServer(
    `should throw DeferredNotFoundError when connecting to non-existent`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/does-not-exist-${Date.now()}`

      await expect(
        DurableDeferred.connect({
          url: deferredUrl,
          signal: aborter.signal,
        })
      ).rejects.toThrow(DeferredNotFoundError)
    }
  )
})

// ============================================================================
// Resolve and Value
// ============================================================================

describe(`DurableDeferred Resolve and Value`, () => {
  testWithServer(
    `should resolve with a value`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-resolve-${Date.now()}`

      const deferred = await DurableDeferred.create<{ result: string }>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      await deferred.resolve({ result: `success` })

      expect(await deferred.state()).toBe(`resolved`)
      expect(await deferred.value).toEqual({ result: `success` })
    }
  )

  testWithServer(
    `should resolve with primitive value`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-primitive-${Date.now()}`

      const deferred = await DurableDeferred.create<number>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      await deferred.resolve(42)

      expect(await deferred.value).toBe(42)
    }
  )

  testWithServer(
    `should throw AlreadyResolvedError on second resolve`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-double-resolve-${Date.now()}`

      const deferred = await DurableDeferred.create<string>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      await deferred.resolve(`first`)

      await expect(deferred.resolve(`second`)).rejects.toThrow(
        AlreadyResolvedError
      )
    }
  )

  testWithServer(
    `should allow multiple readers to get the value`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-multi-read-${Date.now()}`

      // Create and resolve
      const deferred1 = await DurableDeferred.create<string>({
        url: deferredUrl,
        signal: aborter.signal,
      })
      await deferred1.resolve(`shared value`)

      // Multiple readers
      const deferred2 = await DurableDeferred.connect<string>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      const deferred3 = await DurableDeferred.connect<string>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      expect(await deferred2.value).toBe(`shared value`)
      expect(await deferred3.value).toBe(`shared value`)
    }
  )
})

// ============================================================================
// Reject and Error Handling
// ============================================================================

describe(`DurableDeferred Reject and Error Handling`, () => {
  testWithServer(
    `should reject with an error`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-reject-${Date.now()}`

      const deferred = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      const error = new Error(`Something went wrong`)
      await deferred.reject(error)

      expect(await deferred.state()).toBe(`rejected`)
      await expect(deferred.value).rejects.toThrow(`Something went wrong`)
    }
  )

  testWithServer(
    `should throw AlreadyResolvedError on reject after resolve`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-reject-after-resolve-${Date.now()}`

      const deferred = await DurableDeferred.create<string>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      await deferred.resolve(`value`)

      await expect(deferred.reject(new Error(`Should fail`))).rejects.toThrow(
        AlreadyResolvedError
      )
    }
  )

  testWithServer(
    `should throw AlreadyResolvedError on resolve after reject`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-resolve-after-reject-${Date.now()}`

      const deferred = await DurableDeferred.create<string>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      await deferred.reject(new Error(`Failed`))

      await expect(deferred.resolve(`value`)).rejects.toThrow(
        AlreadyResolvedError
      )
    }
  )

  testWithServer(
    `should preserve error name and message across connections`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-error-serialize-${Date.now()}`

      // Create and reject
      const deferred1 = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      const customError = new TypeError(`Custom type error`)
      await deferred1.reject(customError)

      // Connect from "another machine"
      const deferred2 = await DurableDeferred.connect({
        url: deferredUrl,
        signal: aborter.signal,
      })

      try {
        await deferred2.value
        expect.fail(`Should have thrown`)
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
        expect((e as Error).name).toBe(`TypeError`)
        expect((e as Error).message).toBe(`Custom type error`)
      }
    }
  )
})

// ============================================================================
// Wait with Timeout
// ============================================================================

describe(`DurableDeferred Wait with Timeout`, () => {
  testWithServer(
    `should wait and return value`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-wait-${Date.now()}`

      const deferred = await DurableDeferred.create<string>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      // Resolve after a delay
      setTimeout(() => {
        deferred.resolve(`delayed value`)
      }, 50)

      const result = await deferred.wait(5000)
      expect(result).toBe(`delayed value`)
    }
  )

  testWithServer(
    `should throw DeferredTimeoutError on timeout`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-timeout-${Date.now()}`

      const deferred = await DurableDeferred.create<string>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      // Never resolve - should timeout
      await expect(deferred.wait(100)).rejects.toThrow(DeferredTimeoutError)
    }
  )

  testWithServer(
    `should return immediately if already resolved`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-wait-resolved-${Date.now()}`

      const deferred = await DurableDeferred.create<string>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      await deferred.resolve(`immediate`)

      const start = Date.now()
      const result = await deferred.wait(5000)
      const elapsed = Date.now() - start

      expect(result).toBe(`immediate`)
      expect(elapsed).toBeLessThan(100) // Should be nearly instant
    }
  )
})

// ============================================================================
// State and Exists
// ============================================================================

describe(`DurableDeferred State and Exists`, () => {
  testWithServer(
    `state() should return pending for new deferred`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-state-pending-${Date.now()}`

      const deferred = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      expect(await deferred.state()).toBe(`pending`)
    }
  )

  testWithServer(
    `state() should return resolved after resolve`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-state-resolved-${Date.now()}`

      const deferred = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      await deferred.resolve(`value`)

      expect(await deferred.state()).toBe(`resolved`)
    }
  )

  testWithServer(
    `state() should return rejected after reject`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-state-rejected-${Date.now()}`

      const deferred = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      await deferred.reject(new Error(`Failed`))

      expect(await deferred.state()).toBe(`rejected`)
    }
  )

  testWithServer(
    `exists() should return false for non-existent`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/does-not-exist-${Date.now()}`

      // Create a deferred handle without creating the stream
      const deferred = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      // Delete it
      await deferred.delete()

      expect(await deferred.exists()).toBe(false)
    }
  )
})

// ============================================================================
// Delete
// ============================================================================

describe(`DurableDeferred Delete`, () => {
  testWithServer(`should delete a deferred`, async ({ baseUrl, aborter }) => {
    const deferredUrl = `${baseUrl}/deferred-delete-${Date.now()}`

    const deferred = await DurableDeferred.create({
      url: deferredUrl,
      signal: aborter.signal,
    })

    expect(await deferred.exists()).toBe(true)

    await deferred.delete()

    expect(await deferred.exists()).toBe(false)
  })

  testWithServer(
    `should be able to re-create after delete`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-recreate-${Date.now()}`

      // Create and delete
      const deferred1 = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })
      await deferred1.delete()

      // Re-create
      const deferred2 = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      expect(await deferred2.exists()).toBe(true)
      expect(await deferred2.state()).toBe(`pending`)
    }
  )
})

// ============================================================================
// Distributed Use Case
// ============================================================================

describe(`DurableDeferred Distributed Use Cases`, () => {
  testWithServer(
    `should work in producer/consumer pattern`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-producer-consumer-${Date.now()}`

      // Producer creates deferred
      const producer = await DurableDeferred.create<{
        status: string
        result: number
      }>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      // Consumer connects and waits
      const consumer = await DurableDeferred.connect<{
        status: string
        result: number
      }>({
        url: deferredUrl,
        signal: aborter.signal,
      })

      // Start consumer waiting
      const consumerPromise = consumer.value

      // Simulate work and resolve
      await sleep(50)
      await producer.resolve({ status: `complete`, result: 42 })

      // Consumer should receive the value
      const result = await consumerPromise
      expect(result).toEqual({ status: `complete`, result: 42 })
    }
  )

  testWithServer(
    `should handle error propagation across connections`,
    async ({ baseUrl, aborter }) => {
      const deferredUrl = `${baseUrl}/deferred-error-propagation-${Date.now()}`

      // Producer creates deferred
      const producer = await DurableDeferred.create({
        url: deferredUrl,
        signal: aborter.signal,
      })

      // Consumer connects and waits
      const consumer = await DurableDeferred.connect({
        url: deferredUrl,
        signal: aborter.signal,
      })

      // Start consumer waiting
      const consumerPromise = consumer.value

      // Producer encounters an error
      await sleep(50)
      await producer.reject(new Error(`Processing failed`))

      // Consumer should receive the error
      await expect(consumerPromise).rejects.toThrow(`Processing failed`)
    }
  )
})
