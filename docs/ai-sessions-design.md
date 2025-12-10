# AI Sessions Design Notes

Design notes for the AI Sessions package - a collaboration with the TanStack team. This package will live in the TanStack namespace (e.g., `@tanstack/ai-sessions`), built on top of `@durable-streams/state`.

## Overview

AI Sessions provides a high-level API for building AI chat interfaces and agentic applications with:

- Real-time sync via durable streams
- Optimistic mutations with TanStack DB
- Server function integration
- Built-in schemas for common AI primitives
- Cross-device session continuity

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   @tanstack/ai-sessions-react                    │
│                                                                  │
│   useSession(sessionId, config) → { collections, helpers }      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     @tanstack/ai-sessions                        │
│                                                                  │
│   defineSession({ schema, serverFns }) → sessionConfig          │
│   Default schemas: messages, tool_calls, attachments, etc.      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    @durable-streams/state                        │
│                                                                  │
│   Core types, schema validation, materialization                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    @durable-streams/client                       │
│                                                                  │
│   Stream transport (read, write, sync)                          │
└─────────────────────────────────────────────────────────────────┘
```

## Core API

### defineSession

Creates a session configuration with schemas and server functions.

```typescript
import { defineSession } from "@tanstack/ai-sessions"
import { z } from "zod"

// Default schemas provided by the package
import { messageSchema, toolCallSchema } from "@tanstack/ai-sessions/schemas"

// User-defined custom schema
const customDataSchema = z.object({
  id: z.string(),
  // ... custom fields
})

export const chatSessionConfig = defineSession({
  // Schema defines entity types in the session stream
  schema: {
    // Built-in types (can be extended/overridden)
    messages: messageSchema,
    tool_calls: toolCallSchema,
    // Custom types
    custom_data: customDataSchema,
  },

  // Server functions - imported as references, called from client
  serverFns: {
    sendMessage,      // (input) => Promise<{ txid }>
    createUser,
    updateSettings,
    // ...
  },
})
```

### useSession Hook

React hook that connects to a session and provides collections + helpers.

```typescript
import { useSession } from "@tanstack/ai-sessions-react"
import { chatSessionConfig } from "./session-config"

function ChatUI({ sessionId }: { sessionId: string }) {
  const {
    // TanStack DB collections - one per schema type
    collections,

    // Generated helpers that wrap optimistic mutation + serverFn + awaitTxid
    sendMessage,
    createUser,
    updateSettings,

    // Status
    isLoading,
    isConnected,
    error,
  } = useSession(sessionId, chatSessionConfig)

  // Use collections in queries
  const messages = useQuery(
    collections.messages,
    (q) => q.orderBy("createdAt", "asc")
  )

  const toolCalls = useQuery(
    collections.tool_calls,
    (q) => q.where("status", "==", "running")
  )

  // Mutations are simple - helper abstracts the complexity
  const handleSend = async (text: string) => {
    await sendMessage({ text })
    // That's it! Under the hood:
    // 1. Optimistic insert into collections.messages
    // 2. Call serverFns.sendMessage({ text, txid })
    // 3. Await txid in stream
    // 4. Confirm optimistic state
  }

  return (
    <div>
      {messages.map(msg => <Message key={msg.id} {...msg} />)}
      <Input onSend={handleSend} />
    </div>
  )
}
```

## Optimistic Mutations with Client-Generated Txid

The key insight: for pure event-based systems (not Postgres), the client can generate the txid.

```typescript
// Inside the generated helper (e.g., sendMessage)
async function sendMessage(input: { text: string }) {
  // 1. Generate txid on client
  const txid = crypto.randomUUID()
  const id = crypto.randomUUID()

  // 2. Optimistic mutation - instant UI update
  collections.messages.insert({
    id,
    text: input.text,
    role: "user",
    createdAt: new Date().toISOString(),
  })

  // 3. Call server function with txid
  await serverFns.sendMessage({
    id,
    text: input.text,
    txid,  // Server will echo this into the stream
  })

  // 4. Wait for txid to appear in stream
  await awaitTxid(txid)

  // 5. Optimistic state is now confirmed
}
```

Server-side, the serverFn writes to the stream with txid in headers:

```typescript
// Server function implementation
async function sendMessage(input: { id: string; text: string; txid: string }) {
  // Validate, process, call LLM, etc.

  // Write to stream with txid in headers
  await stream.append(
    insert("messages", input.id, {
      id: input.id,
      text: input.text,
      role: "user",
      createdAt: new Date().toISOString(),
    }),
    { headers: { txid: input.txid } }
  )

  // Stream AI response...
}
```

## Stream Structure

One durable stream per session. All entity types flow through the same stream:

```
Stream: /sessions/{sessionId}

Events:
  { type: "messages", key: "msg-1", value: {...}, headers: { txid: "abc", operation: "insert" } }
  { type: "messages", key: "msg-2", value: {...}, headers: { txid: "def", operation: "insert" } }
  { type: "tool_calls", key: "tc-1", value: {...}, headers: { txid: "ghi", operation: "insert" } }
  { type: "tool_calls", key: "tc-1", value: {...}, headers: { operation: "update" } }
  ...
```

The stream handler splits events by `type` field and routes to the appropriate TanStack DB collection.

## Default Schemas

The package provides default schemas for common AI primitives:

```typescript
// @tanstack/ai-sessions/schemas

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
})

export const toolCallSchema = z.object({
  id: z.string(),
  messageId: z.string().optional(),
  tool: z.string(),
  input: z.record(z.unknown()),
  output: z.record(z.unknown()).optional(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
})

export const attachmentSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  type: z.enum(["image", "file", "audio", "video"]),
  url: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
})

export const participantSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["user", "agent", "observer"]),
  joinedAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
})
```

Users can extend or override these:

```typescript
const extendedMessageSchema = messageSchema.extend({
  reactions: z.array(z.string()).optional(),
  threadId: z.string().optional(),
})

const sessionConfig = defineSession({
  schema: {
    messages: extendedMessageSchema,  // Override default
    tool_calls: toolCallSchema,       // Use default
    custom_type: myCustomSchema,      // Add custom
  },
  serverFns: { ... },
})
```

## Shared Sessions

Sessions can be shared between multiple users:

```typescript
// Same sessionId = same stream = real-time sync
const { collections, sendMessage } = useSession("shared-session-123", config)

// All participants see messages in real-time
// Presence could be added via a "participants" type in the schema
```

## Open Questions

1. **Session creation flow**: Who creates the session? Server-side API? First client to connect?

2. **Authentication/authorization**: How to gate access to sessions? Probably handled at the stream URL level.

3. **Session lifecycle**: TTL? Explicit close? Archive vs delete?

4. **Streaming AI responses**: How to handle token-by-token streaming within this model? Separate concern or integrated?

5. **Error handling**: What happens when serverFn fails? Rollback optimistic state? Retry?

6. **Offline support**: Queue mutations when offline? Sync when back online?

## Related Work

- [Vercel AI SDK](https://sdk.vercel.ai/) - AI streaming primitives
- [TanStack DB](https://tanstack.com/db/latest) - Client-side reactive database
- [Electric SQL](https://electric-sql.com/) - Postgres sync (inspiration for patterns)
