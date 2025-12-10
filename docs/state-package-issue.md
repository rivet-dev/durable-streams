# RFC: @durable-streams/state - The State Protocol

## Summary

Implement the **State Protocol** as a new `@durable-streams/state` package. As described in the [Announcing Durable Streams blog post](https://electric-sql.com/blog/2025/12/09/announcing-durable-streams):

> **State Protocol** — A composable schema for state change events (insert/update/delete) that any protocol can adopt when it needs database-style sync semantics

This package will provide:

1. **Type-safe event definitions** for CRUD operations on entities
2. **Event validation** at write time
3. **State materialization** - replaying events to reconstruct current state
4. **TypeScript-first API** with strong type inference

## Background

### Architecture Vision

From the blog post, the Durable Streams ecosystem is layered:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Application Protocols                        │
│  (Presence, CRDTs, Real-time Collaboration, Custom Protocols)   │
├─────────────────────────────────────────────────────────────────┤
│                      Database Adapters                           │
│              (Postgres, MySQL, SQLite replication)               │
├─────────────────────────────────────────────────────────────────┤
│                    AI Transport Plugins                          │
│      (Vercel AI SDK, TanStack AI adapters for resumable         │
│       token streaming and persistent agent sessions)             │
├─────────────────────────────────────────────────────────────────┤
│                      STATE PROTOCOL  ← This RFC                  │
│    (Composable schema for insert/update/delete events)          │
├─────────────────────────────────────────────────────────────────┤
│                      DURABLE STREAMS                             │
│         (Foundational transport layer over HTTP)                 │
└─────────────────────────────────────────────────────────────────┘
```

The State Protocol sits between raw durable streams and higher-level protocols. It provides:
- **For database sync**: The event schema for streaming row changes (what Electric uses)
- **For AI applications**: Could be used for structured agent state, tool outputs, etc.
- **For application protocols**: A common foundation for any protocol needing entity CRUD semantics

### Electric SQL's Implementation

Electric SQL's TypeScript client (`@electric-sql/client`) has a well-designed system for handling database change events. Key concepts:

**Message Types** (`types.ts`):
- `ChangeMessage<T>` - Represents insert/update/delete operations with:
  - `key: string` - Entity identifier
  - `value: T` - The row data (for insert/update)
  - `old_value?: T` - Previous values (for update/delete)
  - `headers: { operation: "insert" | "update" | "delete" }`
- `ControlMessage` - Stream control signals (up-to-date, must-refetch)
- `Value<T>` - Extensible value types (string, number, boolean, null, arrays, objects)
- `Row<T>` - Record<string, Value<T>>

**Shape Materialization** (`shape.ts`):
```typescript
class Shape<T> {
  #data: Map<string, T>  // Materialized state
  #status: "syncing" | "up-to-date"

  // Applies change messages to materialize state
  #applyChange(change: ChangeMessage<T>) {
    switch (change.headers.operation) {
      case "insert":
      case "update":
        this.#data.set(change.key, change.value)
        break
      case "delete":
        this.#data.delete(change.key)
        break
    }
  }
}
```

**Type Parsing** (`parser.ts`):
- Schema-aware parsing with type converters
- Handles PostgreSQL types (int2, int4, int8, bool, float4, float8, json, jsonb)
- Array parsing for PostgreSQL array syntax
- Null handling with nullability constraints

### Durable Streams Current State

Durable streams currently provides:
- Raw byte streams or JSON mode
- No structured event types
- No materialization layer
- Writers send arbitrary JSON values

## Proposed Design

### Package Structure

```
packages/state/
├── src/
│   ├── index.ts           # Public exports
│   ├── types.ts           # Core type definitions
│   ├── operations.ts      # CRUD operation builders
│   ├── schema.ts          # Schema definition helpers
│   ├── materialize.ts     # State materialization
│   ├── validate.ts        # Event validation
│   └── parser.ts          # Optional type parsing
├── package.json
└── README.md
```

### Core Types

```typescript
// types.ts

/**
 * Supported value types (extensible via generics)
 */
export type Value<Extensions = never> =
  | string
  | number
  | boolean
  | bigint
  | null
  | Value<Extensions>[]
  | { [key: string]: Value<Extensions> }
  | Extensions

/**
 * A row/entity record
 */
export type Row<T = Record<string, Value>> = T

/**
 * CRUD operation types
 */
export type Operation = "insert" | "update" | "delete"

/**
 * Event headers containing operation metadata
 */
export interface EventHeaders {
  operation: Operation
  /** ISO 8601 timestamp */
  timestamp?: string
  /** Optional transaction/batch ID */
  txId?: string
}

/**
 * A change event for an entity
 */
export interface ChangeEvent<T extends Row = Row> {
  /** Unique identifier for the entity (e.g., primary key) */
  key: string
  /** Current values (required for insert/update) */
  value?: T
  /** Previous values (optional, for update/delete) */
  old_value?: T
  /** Event metadata */
  headers: EventHeaders
}

/**
 * Control events for stream management
 */
export interface ControlEvent {
  type: "up-to-date" | "snapshot-start" | "snapshot-end" | "reset"
  /** Stream position when this control event was emitted */
  offset?: string
}

/**
 * Union of all event types
 */
export type StreamEvent<T extends Row = Row> =
  | ChangeEvent<T>
  | ControlEvent

/**
 * Type guard for change events
 */
export function isChangeEvent<T extends Row>(
  event: StreamEvent<T>
): event is ChangeEvent<T> {
  return "key" in event && "headers" in event
}

/**
 * Type guard for control events
 */
export function isControlEvent<T extends Row>(
  event: StreamEvent<T>
): event is ControlEvent {
  return "type" in event && !("key" in event)
}
```

### Operation Builders

```typescript
// operations.ts

/**
 * Create an insert event
 */
export function insert<T extends Row>(
  key: string,
  value: T,
  options?: { timestamp?: string; txId?: string }
): ChangeEvent<T> {
  return {
    key,
    value,
    headers: {
      operation: "insert",
      timestamp: options?.timestamp ?? new Date().toISOString(),
      txId: options?.txId,
    },
  }
}

/**
 * Create an update event
 */
export function update<T extends Row>(
  key: string,
  value: T,
  old_value?: T,
  options?: { timestamp?: string; txId?: string }
): ChangeEvent<T> {
  return {
    key,
    value,
    old_value,
    headers: {
      operation: "update",
      timestamp: options?.timestamp ?? new Date().toISOString(),
      txId: options?.txId,
    },
  }
}

/**
 * Create a delete event
 */
export function del<T extends Row>(
  key: string,
  old_value?: T,
  options?: { timestamp?: string; txId?: string }
): ChangeEvent<T> {
  return {
    key,
    old_value,
    headers: {
      operation: "delete",
      timestamp: options?.timestamp ?? new Date().toISOString(),
      txId: options?.txId,
    },
  }
}

/**
 * Create a control event
 */
export function control(
  type: ControlEvent["type"],
  offset?: string
): ControlEvent {
  return { type, offset }
}
```

### Schema Definition with Standard Schema

We use [Standard Schema](https://standardschema.dev/) (`@standard-schema/spec`) for type definitions and validation. This is the same interface used by TanStack DB, TanStack Form, tRPC, and others - providing seamless interoperability with Zod, Valibot, and ArkType.

```typescript
// schema.ts
import type { StandardSchemaV1 } from "@standard-schema/spec"

/**
 * A stream schema defines multiple entity types that can flow through a single stream.
 * Unlike Electric (one shape = one type), durable streams support heterogeneous events.
 */
export interface StreamSchema<TTypes extends Record<string, StandardSchemaV1>> {
  /** Map of entity type name → Standard Schema validator */
  types: TTypes
  /** Optional getKey function per type (defaults to using `id` field) */
  getKey?: Partial<Record<keyof TTypes, (value: unknown) => string>>
}

/**
 * Define a stream schema with multiple entity types
 */
export function defineStreamSchema<
  TTypes extends Record<string, StandardSchemaV1>
>(config: {
  types: TTypes
  getKey?: Partial<Record<keyof TTypes, (value: unknown) => string>>
}): StreamSchema<TTypes> {
  return config
}

// Example usage with Zod:
import { z } from "zod"

const messageSchema = z.object({
  id: z.string(),
  text: z.string(),
  userId: z.string(),
  createdAt: z.string().datetime(),
})

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

const toolCallSchema = z.object({
  id: z.string(),
  tool: z.string(),
  input: z.record(z.unknown()),
  output: z.record(z.unknown()).optional(),
  status: z.enum(["pending", "running", "completed", "failed"]),
})

// Define a stream that can carry multiple entity types
const chatStreamSchema = defineStreamSchema({
  types: {
    messages: messageSchema,
    users: userSchema,
    tool_calls: toolCallSchema,
  },
})

// Infer types from schema
type Message = z.infer<typeof messageSchema>
type User = z.infer<typeof userSchema>
type ToolCall = z.infer<typeof toolCallSchema>
```

### Multi-Type Streams

Unlike Electric (one shape = one table = one type), durable streams support **multiple entity types per stream**. Each change event includes a `type` field to discriminate:

```typescript
/**
 * A change event for a typed entity
 * The `type` field identifies which schema to use for validation
 */
export interface ChangeEvent<T extends Row = Row> {
  /** Entity type discriminator - identifies which schema applies */
  type: string  // e.g., "messages", "users", "tool_calls"

  /** Unique identifier within the type */
  key: string

  /** Current values (for insert/update) */
  value?: T

  /** Previous values (for update/delete) */
  old_value?: T

  /** Event metadata */
  headers: {
    operation: "insert" | "update" | "delete"
    timestamp?: string
    txid?: string  // Transaction ID for optimistic mutation confirmation
  }
}

// Type-safe operation builders that include the type field
export function insert<K extends keyof TTypes>(
  type: K,
  key: string,
  value: InferOutput<TTypes[K]>,
  options?: { txid?: string }
): ChangeEvent<InferOutput<TTypes[K]>>

export function update<K extends keyof TTypes>(
  type: K,
  key: string,
  value: InferOutput<TTypes[K]>,
  old_value?: InferOutput<TTypes[K]>,
  options?: { txid?: string }
): ChangeEvent<InferOutput<TTypes[K]>>

export function del<K extends keyof TTypes>(
  type: K,
  key: string,
  old_value?: InferOutput<TTypes[K]>,
  options?: { txid?: string }
): ChangeEvent<InferOutput<TTypes[K]>>
```

**Benefits of multi-type streams:**
- Agent sessions with mixed events (messages, tool calls, state changes)
- Event sourcing with domain events
- Chat rooms with messages + presence + reactions
- Reduced stream count - one stream per logical unit (session, room, document)

### State Materialization

```typescript
// materialize.ts

/**
 * Options for state materialization
 */
export interface MaterializeOptions<T extends Row> {
  /** Schema for validation (optional) */
  schema?: Schema<T>
  /** Custom key extractor (default: uses event.key) */
  keyFn?: (event: ChangeEvent<T>) => string
  /** Called when state changes */
  onChange?: (state: Map<string, T>, event: ChangeEvent<T>) => void
}

/**
 * Materialized state container
 *
 * Tracks the current state of entities by applying change events.
 * Similar to Electric's Shape class but decoupled from streaming.
 */
export class MaterializedState<T extends Row = Row> {
  #data: Map<string, T> = new Map()
  #options: MaterializeOptions<T>

  constructor(options: MaterializeOptions<T> = {}) {
    this.#options = options
  }

  /**
   * Apply a single change event
   */
  apply(event: ChangeEvent<T>): void {
    const key = this.#options.keyFn?.(event) ?? event.key

    switch (event.headers.operation) {
      case "insert":
        if (!event.value) throw new Error("Insert event requires value")
        this.#data.set(key, event.value)
        break

      case "update":
        if (!event.value) throw new Error("Update event requires value")
        this.#data.set(key, event.value)
        break

      case "delete":
        this.#data.delete(key)
        break
    }

    this.#options.onChange?.(this.#data, event)
  }

  /**
   * Apply multiple events (e.g., from stream replay)
   */
  applyBatch(events: ChangeEvent<T>[]): void {
    for (const event of events) {
      this.apply(event)
    }
  }

  /**
   * Reset state (e.g., on must-refetch)
   */
  clear(): void {
    this.#data.clear()
  }

  /**
   * Get current state as Map
   */
  get data(): Map<string, T> {
    return this.#data
  }

  /**
   * Get current state as array
   */
  get rows(): T[] {
    return Array.from(this.#data.values())
  }

  /**
   * Get a single entity by key
   */
  get(key: string): T | undefined {
    return this.#data.get(key)
  }

  /**
   * Check if entity exists
   */
  has(key: string): boolean {
    return this.#data.has(key)
  }

  /**
   * Get number of entities
   */
  get size(): number {
    return this.#data.size
  }
}

/**
 * Helper to materialize events from a stream
 */
export function materialize<T extends Row>(
  events: Iterable<StreamEvent<T>>,
  options?: MaterializeOptions<T>
): MaterializedState<T> {
  const state = new MaterializedState<T>(options)

  for (const event of events) {
    if (isChangeEvent(event)) {
      state.apply(event)
    } else if (event.type === "reset") {
      state.clear()
    }
  }

  return state
}

/**
 * Async version for stream replay
 */
export async function materializeAsync<T extends Row>(
  events: AsyncIterable<StreamEvent<T>>,
  options?: MaterializeOptions<T>
): Promise<MaterializedState<T>> {
  const state = new MaterializedState<T>(options)

  for await (const event of events) {
    if (isChangeEvent(event)) {
      state.apply(event)
    } else if (event.type === "reset") {
      state.clear()
    }
  }

  return state
}
```

### Event Validation

```typescript
// validate.ts

export interface ValidationError {
  path: string
  message: string
  value?: unknown
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

/**
 * Validate a change event against a schema
 */
export function validateEvent<T extends Row>(
  event: ChangeEvent<T>,
  schema: Schema<T>
): ValidationResult {
  const errors: ValidationError[] = []

  // Validate key exists
  if (!event.key) {
    errors.push({ path: "key", message: "Key is required" })
  }

  // Validate operation
  if (!["insert", "update", "delete"].includes(event.headers.operation)) {
    errors.push({
      path: "headers.operation",
      message: `Invalid operation: ${event.headers.operation}`
    })
  }

  // Validate value for insert/update
  if (event.headers.operation !== "delete") {
    if (!event.value) {
      errors.push({
        path: "value",
        message: `Value required for ${event.headers.operation}`
      })
    } else {
      // Validate against schema columns
      for (const [col, def] of Object.entries(schema.columns)) {
        const value = (event.value as Record<string, unknown>)[col]

        if (value === undefined || value === null) {
          if (!def.nullable && def.default === undefined) {
            errors.push({
              path: `value.${col}`,
              message: `Required column "${col}" is missing or null`,
            })
          }
        } else {
          // Type validation could be added here
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Create a validated event builder
 */
export function createEventBuilder<T extends Row>(schema: Schema<T>) {
  return {
    insert(key: string, value: T): ChangeEvent<T> {
      const event = insert(key, value)
      const result = validateEvent(event, schema)
      if (!result.valid) {
        throw new Error(`Invalid insert event: ${JSON.stringify(result.errors)}`)
      }
      return event
    },

    update(key: string, value: T, old_value?: T): ChangeEvent<T> {
      const event = update(key, value, old_value)
      const result = validateEvent(event, schema)
      if (!result.valid) {
        throw new Error(`Invalid update event: ${JSON.stringify(result.errors)}`)
      }
      return event
    },

    delete(key: string, old_value?: T): ChangeEvent<T> {
      const event = del(key, old_value)
      return event
    },
  }
}
```

### Integration with @durable-streams/writer

```typescript
// Example: StateStream class that combines writer + state
import { DurableStream } from "@durable-streams/writer"
import {
  ChangeEvent,
  MaterializedState,
  isChangeEvent,
  insert,
  update,
  del
} from "@durable-streams/state"

export class StateStream<T extends Row> {
  #stream: DurableStream
  #state: MaterializedState<T>

  constructor(stream: DurableStream, options?: MaterializeOptions<T>) {
    this.#stream = stream
    this.#state = new MaterializedState<T>(options)
  }

  /**
   * Insert an entity
   */
  async insert(key: string, value: T): Promise<void> {
    const event = insert(key, value)
    await this.#stream.append(event)
    this.#state.apply(event)
  }

  /**
   * Update an entity
   */
  async update(key: string, value: T): Promise<void> {
    const old_value = this.#state.get(key)
    const event = update(key, value, old_value)
    await this.#stream.append(event)
    this.#state.apply(event)
  }

  /**
   * Delete an entity
   */
  async delete(key: string): Promise<void> {
    const old_value = this.#state.get(key)
    const event = del(key, old_value)
    await this.#stream.append(event)
    this.#state.apply(event)
  }

  /**
   * Get current state
   */
  get state(): MaterializedState<T> {
    return this.#state
  }

  /**
   * Replay from stream to rebuild state
   */
  async replay(): Promise<void> {
    this.#state.clear()

    for await (const message of this.#stream.json<ChangeEvent<T>>({ live: false })) {
      if (isChangeEvent(message)) {
        this.#state.apply(message)
      }
    }
  }
}
```

## Usage Examples

### Basic CRUD Operations

```typescript
import { insert, update, del, materialize } from "@durable-streams/state"

interface Todo {
  id: string
  title: string
  completed: boolean
}

// Create events
const events = [
  insert("1", { id: "1", title: "Buy milk", completed: false }),
  insert("2", { id: "2", title: "Walk dog", completed: false }),
  update("1", { id: "1", title: "Buy milk", completed: true }),
  del("2"),
]

// Materialize to current state
const state = materialize(events)
console.log(state.rows) // [{ id: "1", title: "Buy milk", completed: true }]
```

### With Schema Validation

```typescript
import { defineSchema, createEventBuilder } from "@durable-streams/state"

interface User {
  id: string
  email: string
  name: string
}

const userSchema = defineSchema<User>({
  id: { type: "string", primaryKey: true },
  email: { type: "string", nullable: false },
  name: { type: "string", nullable: false },
}, "id")

const users = createEventBuilder(userSchema)

// This will throw if validation fails
const event = users.insert("user-1", {
  id: "user-1",
  email: "alice@example.com",
  name: "Alice",
})
```

### With Durable Stream

```typescript
import { DurableStream } from "@durable-streams/writer"
import { MaterializedState, isChangeEvent, ChangeEvent } from "@durable-streams/state"

interface Message {
  id: string
  text: string
  userId: string
}

// Create stream and state
const stream = await DurableStream.create({
  url: "https://streams.example.com/chat/room-1",
  contentType: "application/json",
})

const state = new MaterializedState<Message>()

// Write events
await stream.append(insert("msg-1", { id: "msg-1", text: "Hello!", userId: "user-1" }))
await stream.append(insert("msg-2", { id: "msg-2", text: "Hi there!", userId: "user-2" }))

// Replay to rebuild state
for await (const event of stream.json<ChangeEvent<Message>>({ live: false })) {
  if (isChangeEvent(event)) {
    state.apply(event)
  }
}

console.log(state.rows)
// [
//   { id: "msg-1", text: "Hello!", userId: "user-1" },
//   { id: "msg-2", text: "Hi there!", userId: "user-2" }
// ]
```

### React Integration (Future)

```typescript
// @durable-streams/react (future package)
import { useStream } from "@durable-streams/react"

function TodoList() {
  const { state, insert, update, del, isLoading, error } = useStream<Todo>({
    url: "https://streams.example.com/todos",
  })

  if (isLoading) return <div>Loading...</div>
  if (error) return <div>Error: {error.message}</div>

  return (
    <ul>
      {state.rows.map(todo => (
        <li key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => update(todo.id, { ...todo, completed: !todo.completed })}
          />
          {todo.title}
          <button onClick={() => del(todo.id)}>Delete</button>
        </li>
      ))}
    </ul>
  )
}
```

## Key Differences from Electric

| Aspect | Electric SQL (Current) | @durable-streams/state |
|--------|------------------------|----------------------|
| **Data source** | PostgreSQL tables via shape log | Any JSON events via durable stream |
| **Key format** | Composite keys from PK columns | Simple string keys |
| **Schema** | Derived from Postgres schema | Optional TypeScript definitions |
| **Type parsing** | PostgreSQL type converters | JSON native types |
| **Streaming** | ShapeStream with built-in materialization | Decoupled: events + separate materializer |
| **Control messages** | up-to-date, must-refetch, snapshot-end | Extensible control events |
| **Coupling** | Bundled with Electric transport | Composable, works with any durable stream |

### Electric 2.0 Context

From the blog post:

> As we build Electric 2.0, we're separating the foundation from the ecosystem so each piece can be used independently or composed together

The State Protocol is part of this separation:
- **Electric 1.x**: Everything bundled together (transport + protocol + Postgres adapter)
- **Electric 2.0**: Layered architecture where State Protocol can be used independently

This means `@durable-streams/state` should be designed to:
1. Work standalone for non-database use cases (AI, event sourcing, etc.)
2. Be composable with database adapters for sync use cases
3. Be framework-agnostic (React hooks come separately)

## Implementation Plan

### Phase 1: Core Types
- [ ] Define `ChangeEvent`, `ControlEvent`, `StreamEvent` types
- [ ] Implement type guards (`isChangeEvent`, `isControlEvent`)
- [ ] Create operation builders (`insert`, `update`, `del`, `control`)
- [ ] Add comprehensive JSDoc documentation

### Phase 2: Materialization
- [ ] Implement `MaterializedState` class
- [ ] Add `materialize()` and `materializeAsync()` helpers
- [ ] Support custom key extraction
- [ ] Add change notification callbacks

### Phase 3: Schema & Validation
- [ ] Schema definition helpers
- [ ] Event validation functions
- [ ] Validated event builders

### Phase 4: Integration
- [ ] Add usage examples with `@durable-streams/writer`
- [ ] Create `StateStream` wrapper class (optional)
- [ ] Document patterns for common use cases

### Phase 5: Testing
- [ ] Unit tests for all core functionality
- [ ] Integration tests with durable streams
- [ ] Type inference tests (test-d.ts)
- [ ] Performance benchmarks for materialization

## Open Questions

1. **Should schemas be runtime-validated or compile-time only?**
   - Runtime validation adds overhead but catches more errors
   - Could make validation opt-in via a `validate: true` option

2. **How to handle partial updates?**
   - Electric sends full row values
   - Should we support patch-style updates?
   - Suggestion: Support both `update` (full) and `patch` (partial) operations

3. **Should we include snapshot support?**
   - Electric has complex snapshot tracking for deduplication
   - Durable streams already handles this at the protocol level
   - Probably not needed initially

4. **Key generation strategies?**
   - Auto-generated UUIDs?
   - Compound keys from multiple fields?
   - Leave to user for now

5. **Optimistic updates?**
   - Apply locally before server confirmation
   - Rollback on failure
   - Add in future version

## Use Cases & Example Applications

These examples demonstrate the flexibility of the State Protocol and serve as candidates for integration tests.

### 1. Key/Value Store
A simple synced key/value store with optimistic mutations.

```typescript
const kvSchema = defineStreamSchema({
  types: {
    entries: z.object({
      id: z.string(),
      value: z.unknown(),
      expiresAt: z.string().datetime().optional(),
    })
  }
})

// Usage with TanStack DB - optimistic set/get/delete
await kv.set("user:123:prefs", { theme: "dark", lang: "en" })
const prefs = kv.get("user:123:prefs")
await kv.delete("user:123:prefs")
```

### 2. Presence API
Track who's online in a room/channel with heartbeats.

```typescript
const presenceSchema = defineStreamSchema({
  types: {
    presence: z.object({
      id: z.string(),           // {userId}
      userName: z.string(),
      status: z.enum(["online", "away", "busy"]),
      lastSeen: z.string().datetime(),
      metadata: z.record(z.unknown()).optional(),  // cursor position, etc.
    })
  }
})

// One stream per room - insert on join, update on heartbeat, delete on leave
// Timeout is client-side: filter by lastSeen
const activeUsers = presence.rows.filter(
  p => Date.now() - new Date(p.lastSeen).getTime() < 60_000
)
```

### 3. Chat Room (multi-type)
One stream per room with messages, users, reactions, and read receipts.

```typescript
const chatRoomSchema = defineStreamSchema({
  types: {
    users: z.object({
      id: z.string(),
      name: z.string(),
      avatar: z.string().optional(),
      joinedAt: z.string().datetime(),
    }),
    messages: z.object({
      id: z.string(),
      text: z.string(),
      userId: z.string(),
      createdAt: z.string().datetime(),
      editedAt: z.string().datetime().optional(),
    }),
    reactions: z.object({
      id: z.string(),           // {userId}:{messageId}:{emoji}
      messageId: z.string(),
      userId: z.string(),
      emoji: z.string(),
    }),
    read_receipts: z.object({
      id: z.string(),           // {userId}
      userId: z.string(),
      lastReadMessageId: z.string(),
      lastReadAt: z.string().datetime(),
    }),
  }
})
```

### 4. Feature Flags / Remote Config
Real-time feature flags that propagate instantly to all clients.

```typescript
const configSchema = defineStreamSchema({
  types: {
    flags: z.object({
      id: z.string(),           // flag name
      enabled: z.boolean(),
      rolloutPercent: z.number().min(0).max(100).optional(),
      allowlist: z.array(z.string()).optional(),
      metadata: z.record(z.unknown()).optional(),
    })
  }
})

// One global stream - all clients subscribe
// Updates propagate instantly to all connected clients
// Great for A/B testing, gradual rollouts, kill switches
```

### 5. Todo List / Kanban Board
Collaborative task management with columns and cards.

```typescript
const kanbanSchema = defineStreamSchema({
  types: {
    columns: z.object({
      id: z.string(),
      name: z.string(),
      position: z.number(),
    }),
    cards: z.object({
      id: z.string(),
      columnId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      position: z.number(),
      assigneeId: z.string().optional(),
      dueDate: z.string().datetime().optional(),
    }),
  }
})
// One stream per board - real-time collaboration
```

### 6. Notification Feed
User notifications with read/unread state.

```typescript
const notificationSchema = defineStreamSchema({
  types: {
    notifications: z.object({
      id: z.string(),
      type: z.enum(["mention", "reply", "like", "follow", "system"]),
      title: z.string(),
      body: z.string().optional(),
      link: z.string().optional(),
      read: z.boolean(),
      createdAt: z.string().datetime(),
    })
  }
})
// One stream per user - replay for history, live tail for new notifications
```

### 7. Audit Log (insert-only)
Immutable event log for compliance and debugging.

```typescript
const auditSchema = defineStreamSchema({
  types: {
    events: z.object({
      id: z.string(),
      action: z.string(),           // "user.created", "document.deleted"
      actorId: z.string(),
      targetType: z.string(),
      targetId: z.string(),
      metadata: z.record(z.unknown()),
      timestamp: z.string().datetime(),
    })
  }
})
// Insert only - no updates or deletes (immutable log)
// Replay and filter for queries
```

### 8. Shopping Cart (cross-device sync)
Cart that syncs across phone, tablet, and desktop.

```typescript
const cartSchema = defineStreamSchema({
  types: {
    items: z.object({
      id: z.string(),           // product:{productId}
      productId: z.string(),
      name: z.string(),
      price: z.number(),
      quantity: z.number(),
      addedAt: z.string().datetime(),
    })
  }
})
// One stream per user's cart - syncs across all devices
```

## Syncing State to Databases

For long streams or complex queries, you may want to persist state to a database rather than materializing in memory each time.

### Pattern: Persistent Sync Worker

A background process that consumes the stream and writes to a database:

```typescript
async function syncToDatabase(stream: DurableStream, db: Database) {
  // Resume from last synced offset
  const lastOffset = await db.query(
    "SELECT offset FROM _sync_state WHERE stream_url = ?",
    [stream.url]
  ) ?? "-1"

  for await (const chunk of stream.read({ offset: lastOffset })) {
    await db.transaction(async (tx) => {
      for (const event of parseEvents(chunk.data)) {
        if (!isChangeEvent(event)) continue

        const table = event.type  // type maps to table name

        switch (event.headers.operation) {
          case "insert":
          case "update":
            // Upsert - idempotent for replay
            await tx.query(`
              INSERT INTO ${table} (id, data, updated_at)
              VALUES (?, ?, NOW())
              ON CONFLICT (id) DO UPDATE SET data = ?, updated_at = NOW()
            `, [event.key, event.value, event.value])
            break
          case "delete":
            await tx.query(`DELETE FROM ${table} WHERE id = ?`, [event.key])
            break
        }
      }

      // Update sync checkpoint
      await tx.query(`
        INSERT INTO _sync_state (stream_url, offset, synced_at)
        VALUES (?, ?, NOW())
        ON CONFLICT (stream_url) DO UPDATE SET offset = ?, synced_at = NOW()
      `, [stream.url, chunk.offset, chunk.offset])
    })
  }
}
```

### Target Databases

- **SQLite / IndexedDB** - Client-side for offline-first apps
- **PostgreSQL / MySQL** - Server-side for SQL queries, joins, analytics
- **Redis** - Cache layer for high-read scenarios
- **Elasticsearch / Typesense** - Full-text search over stream data

### Key Considerations

1. **Idempotency**: Use `(type, key)` as primary key with upsert semantics
2. **Offset tracking**: Store last processed offset, resume on restart
3. **Schema generation**: Could generate CREATE TABLE from StreamSchema

## References

- [Announcing Durable Streams (Blog Post)](https://electric-sql.com/blog/2025/12/09/announcing-durable-streams)
- [Standard Schema Specification](https://standardschema.dev/)
- [TanStack DB Documentation](https://tanstack.com/db/latest)
- [Electric SQL TypeScript Client](https://github.com/electric-sql/electric/tree/main/packages/typescript-client)
- [Durable Streams Protocol](./PROTOCOL.md)
- [Durable Streams GitHub](https://github.com/durable-streams/durable-streams)
