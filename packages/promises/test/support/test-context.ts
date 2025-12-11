/**
 * Test fixtures for promise combinator tests.
 */

import { test } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import type { StreamStore } from "@durable-streams/server"

/**
 * Base test fixture with server and abort controller.
 */
export const testWithServer = test.extend<{
  server: DurableStreamTestServer
  store: StreamStore
  baseUrl: string
  aborter: AbortController
}>({
  // Server fixture - creates a new server for each test
  // eslint-disable-next-line no-empty-pattern
  server: async ({}, use) => {
    const server = new DurableStreamTestServer({ port: 0 }) // Random port
    await server.start()
    await use(server)
    await server.stop()
  },

  // Store fixture - direct access to the store
  store: async ({ server }, use) => {
    await use(server.store)
  },

  // Base URL fixture
  baseUrl: async ({ server }, use) => {
    await use(server.url)
  },

  // Abort controller fixture - for cleanup
  // eslint-disable-next-line no-empty-pattern
  aborter: async ({}, use) => {
    const controller = new AbortController()
    await use(controller)
    controller.abort(`Test complete`)
  },
})

/**
 * Extended fixture with a pre-created JSON stream.
 */
export const testWithJsonStream = testWithServer.extend<{
  streamPath: string
  streamUrl: string
}>({
  // Create a JSON stream for each test
  streamPath: async ({ store, task }, use) => {
    const streamPath = `/test-json-stream-${task.id}-${Math.random().toString(16).slice(2)}`
    store.create(streamPath, { contentType: `application/json` })
    await use(streamPath)
  },

  streamUrl: async ({ baseUrl, streamPath }, use) => {
    await use(`${baseUrl}${streamPath}`)
  },
})

/**
 * Extended fixture with a pre-created text stream.
 */
export const testWithTextStream = testWithServer.extend<{
  streamPath: string
  streamUrl: string
}>({
  streamPath: async ({ store, task }, use) => {
    const streamPath = `/test-text-stream-${task.id}-${Math.random().toString(16).slice(2)}`
    store.create(streamPath, { contentType: `text/plain` })
    await use(streamPath)
  },

  streamUrl: async ({ baseUrl, streamPath }, use) => {
    await use(`${baseUrl}${streamPath}`)
  },
})
