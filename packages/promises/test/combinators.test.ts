/**
 * Tests for promise combinators.
 */

import { describe, expect, it } from "vitest"
import {
  EmptyStreamError,
  NotFoundError,
  TimeoutError,
  collect,
  find,
  first,
  last,
  reduce,
  take,
} from "../src/index"
import {
  emptyIterable,
  toAsyncIterable,
  toAsyncIterableWithDelay,
} from "./support/test-helpers"

// ============================================================================
// first()
// ============================================================================

describe(`first()`, () => {
  it(`should return the first value from an async iterable`, async () => {
    const iterable = toAsyncIterable([1, 2, 3])
    const result = await first(iterable)
    expect(result).toBe(1)
  })

  it(`should throw EmptyStreamError for empty iterable`, async () => {
    const iterable = emptyIterable<number>()
    await expect(first(iterable)).rejects.toThrow(EmptyStreamError)
  })

  it(`should respect timeout`, async () => {
    const iterable = toAsyncIterableWithDelay([1, 2, 3], 100)
    await expect(first(iterable, { timeout: 10 })).rejects.toThrow(TimeoutError)
  })

  it(`should work with strings`, async () => {
    const iterable = toAsyncIterable([`a`, `b`, `c`])
    const result = await first(iterable)
    expect(result).toBe(`a`)
  })

  it(`should work with objects`, async () => {
    const iterable = toAsyncIterable([{ id: 1 }, { id: 2 }])
    const result = await first(iterable)
    expect(result).toEqual({ id: 1 })
  })
})

// ============================================================================
// last()
// ============================================================================

describe(`last()`, () => {
  it(`should return the last value from an async iterable`, async () => {
    const iterable = toAsyncIterable([1, 2, 3])
    const result = await last(iterable)
    expect(result).toBe(3)
  })

  it(`should throw EmptyStreamError for empty iterable`, async () => {
    const iterable = emptyIterable<number>()
    await expect(last(iterable)).rejects.toThrow(EmptyStreamError)
  })

  it(`should respect timeout`, async () => {
    const iterable = toAsyncIterableWithDelay([1, 2, 3], 100)
    await expect(last(iterable, { timeout: 50 })).rejects.toThrow(TimeoutError)
  })

  it(`should work with single item`, async () => {
    const iterable = toAsyncIterable([42])
    const result = await last(iterable)
    expect(result).toBe(42)
  })
})

// ============================================================================
// take()
// ============================================================================

describe(`take()`, () => {
  it(`should take first n values`, async () => {
    const iterable = toAsyncIterable([1, 2, 3, 4, 5])
    const result = await take(iterable, 3)
    expect(result).toEqual([1, 2, 3])
  })

  it(`should return fewer if stream ends early`, async () => {
    const iterable = toAsyncIterable([1, 2])
    const result = await take(iterable, 5)
    expect(result).toEqual([1, 2])
  })

  it(`should return empty array for n=0`, async () => {
    const iterable = toAsyncIterable([1, 2, 3])
    const result = await take(iterable, 0)
    expect(result).toEqual([])
  })

  it(`should return empty array for negative n`, async () => {
    const iterable = toAsyncIterable([1, 2, 3])
    const result = await take(iterable, -5)
    expect(result).toEqual([])
  })

  it(`should respect timeout`, async () => {
    const iterable = toAsyncIterableWithDelay([1, 2, 3, 4, 5], 50)
    await expect(take(iterable, 5, { timeout: 100 })).rejects.toThrow(
      TimeoutError
    )
  })

  it(`should work with empty iterable`, async () => {
    const iterable = emptyIterable<number>()
    const result = await take(iterable, 5)
    expect(result).toEqual([])
  })
})

// ============================================================================
// collect()
// ============================================================================

describe(`collect()`, () => {
  it(`should collect all values into an array`, async () => {
    const iterable = toAsyncIterable([1, 2, 3, 4, 5])
    const result = await collect(iterable)
    expect(result).toEqual([1, 2, 3, 4, 5])
  })

  it(`should return empty array for empty iterable`, async () => {
    const iterable = emptyIterable<number>()
    const result = await collect(iterable)
    expect(result).toEqual([])
  })

  it(`should respect maxItems limit`, async () => {
    const iterable = toAsyncIterable([1, 2, 3, 4, 5])
    await expect(collect(iterable, { maxItems: 3 })).rejects.toThrow(
      /exceeded maximum item limit/
    )
  })

  it(`should use default maxItems of 10,000`, async () => {
    // Just test a smaller collection works
    const items = Array.from({ length: 100 }, (_, i) => i)
    const iterable = toAsyncIterable(items)
    const result = await collect(iterable)
    expect(result).toHaveLength(100)
  })

  it(`should respect timeout`, async () => {
    const iterable = toAsyncIterableWithDelay([1, 2, 3, 4, 5], 50)
    await expect(collect(iterable, { timeout: 100 })).rejects.toThrow(
      TimeoutError
    )
  })
})

// ============================================================================
// reduce()
// ============================================================================

describe(`reduce()`, () => {
  it(`should reduce values to a single result`, async () => {
    const iterable = toAsyncIterable([1, 2, 3, 4, 5])
    const result = await reduce(iterable, (acc, val) => acc + val, 0)
    expect(result).toBe(15)
  })

  it(`should return initial value for empty iterable`, async () => {
    const iterable = emptyIterable<number>()
    const result = await reduce(iterable, (acc, val) => acc + val, 100)
    expect(result).toBe(100)
  })

  it(`should pass index to reducer`, async () => {
    const iterable = toAsyncIterable([`a`, `b`, `c`])
    const indices: Array<number> = []
    await reduce(
      iterable,
      (acc, _, idx) => {
        indices.push(idx)
        return acc
      },
      ``
    )
    expect(indices).toEqual([0, 1, 2])
  })

  it(`should work with complex accumulator`, async () => {
    const iterable = toAsyncIterable([
      { name: `Alice`, age: 30 },
      { name: `Bob`, age: 25 },
    ])
    const result = await reduce(
      iterable,
      (acc, person) => {
        acc.totalAge += person.age
        acc.names.push(person.name)
        return acc
      },
      { totalAge: 0, names: [] as Array<string> }
    )
    expect(result).toEqual({ totalAge: 55, names: [`Alice`, `Bob`] })
  })

  it(`should respect timeout`, async () => {
    const iterable = toAsyncIterableWithDelay([1, 2, 3], 50)
    await expect(
      reduce(iterable, (acc, val) => acc + val, 0, { timeout: 50 })
    ).rejects.toThrow(TimeoutError)
  })
})

// ============================================================================
// find()
// ============================================================================

describe(`find()`, () => {
  it(`should find the first matching value`, async () => {
    const iterable = toAsyncIterable([1, 2, 3, 4, 5])
    const result = await find(iterable, (val) => val > 3)
    expect(result).toBe(4)
  })

  it(`should throw NotFoundError if no match`, async () => {
    const iterable = toAsyncIterable([1, 2, 3])
    await expect(find(iterable, (val) => val > 10)).rejects.toThrow(
      NotFoundError
    )
  })

  it(`should throw NotFoundError for empty iterable`, async () => {
    const iterable = emptyIterable<number>()
    await expect(find(iterable, () => true)).rejects.toThrow(NotFoundError)
  })

  it(`should pass index to predicate`, async () => {
    const iterable = toAsyncIterable([`a`, `b`, `c`])
    const result = await find(iterable, (_, idx) => idx === 2)
    expect(result).toBe(`c`)
  })

  it(`should work with async predicate`, async () => {
    const iterable = toAsyncIterable([1, 2, 3, 4, 5])
    const result = await find(iterable, async (val) => {
      await new Promise((r) => setTimeout(r, 1))
      return val === 3
    })
    expect(result).toBe(3)
  })

  it(`should respect timeout`, async () => {
    const iterable = toAsyncIterableWithDelay([1, 2, 3, 4, 5], 50)
    await expect(
      find(iterable, (val) => val === 5, { timeout: 100 })
    ).rejects.toThrow(TimeoutError)
  })

  it(`should find objects by property`, async () => {
    const iterable = toAsyncIterable([
      { id: 1, name: `Alice` },
      { id: 2, name: `Bob` },
      { id: 3, name: `Charlie` },
    ])
    const result = await find(iterable, (item) => item.name === `Bob`)
    expect(result).toEqual({ id: 2, name: `Bob` })
  })
})

// ============================================================================
// AbortSignal handling
// ============================================================================

describe(`AbortSignal handling`, () => {
  it(`first() should abort on signal`, async () => {
    const controller = new AbortController()
    controller.abort()

    const iterable = toAsyncIterable([1, 2, 3])
    await expect(
      first(iterable, { signal: controller.signal })
    ).rejects.toThrow()
  })

  it(`collect() should abort on signal`, async () => {
    const controller = new AbortController()
    controller.abort()

    const iterable = toAsyncIterable([1, 2, 3])
    await expect(
      collect(iterable, { signal: controller.signal })
    ).rejects.toThrow()
  })

  it(`find() should abort on signal`, async () => {
    const controller = new AbortController()
    controller.abort()

    const iterable = toAsyncIterable([1, 2, 3])
    await expect(
      find(iterable, () => true, { signal: controller.signal })
    ).rejects.toThrow()
  })
})
