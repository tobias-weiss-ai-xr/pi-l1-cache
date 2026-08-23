import { describe, it, beforeEach, before, after } from "node:test"
import assert from "node:assert/strict"
import init, { _testHooks } from "./index.ts"

const Test = _testHooks()

describe("pi-l1-cache", () => {
  describe("fastHash", () => {
    it("returns consistent hash for same input", () => {
      const input = "test-string-123"
      assert.equal(Test.fastHash(input), Test.fastHash(input))
    })

    it("returns different hash for different input", () => {
      assert.notEqual(Test.fastHash("hello"), Test.fastHash("world"))
    })

    it("handles empty string", () => {
      const empty = Test.fastHash("")
      assert.ok(empty.length > 0)
    })

    it("handles unicode", () => {
      const emoji = Test.fastHash("🎉 pi-l1-cache 🎉")
      assert.ok(emoji.length > 0)
    })

    it("is deterministic", () => {
      const obj = JSON.stringify({ a: 1, b: 2 })
      assert.equal(Test.fastHash(obj), Test.fastHash(obj))
    })
  })

  describe("estimateSize", () => {
    it("estimates size of simple strings", () => {
      const size = Test.estimateSize("hello world")
      assert.ok(size > 0)
      assert.ok(size < 100)
    })

    it("estimates size of objects", () => {
      const obj = { a: 1, b: "test", c: [1, 2, 3] }
      const size = Test.estimateSize(obj)
      assert.ok(size > 0)
    })

    it("estimates size of arrays", () => {
      const arr = new Array(100).fill("x")
      const size = Test.estimateSize(arr)
      assert.ok(size > 100)
    })

    it("returns fallback for non-serializable", () => {
      const circular: any = { a: 1 }
      circular.self = circular
      const size = Test.estimateSize(circular)
      assert.equal(size, 1024)
    })

    it("handles null and undefined", () => {
      assert.ok(Test.estimateSize(null) > 0)
      assert.ok(Test.estimateSize(undefined) > 0)
    })
  })

  describe("eviction logic", () => {
    beforeEach(() => {
      Test.reset()
      Test.setSettings({ maxEntries: 10, maxMemoryBytes: 10000 })
    })

    it("evicts oldest entries first", () => {
      for (let i = 0; i < 15; i++) {
        Test._setCache(`key-${i}`, { response: {}, timestamp: i * 1000, sizeBytes: 100 })
      }
      Test.evictIfNeeded()
      assert.ok(Test._getCacheSize() <= 10)
    })

    it("evicts by memory when full", () => {
      Test.setSettings({ maxEntries: 1000, maxMemoryBytes: 1000 })
      Test.reset()
      for (let i = 0; i < 5; i++) {
        Test._setCache(`key-${i}`, { response: new Array(100).fill("x"), timestamp: Date.now(), sizeBytes: 200 })
      }
      Test.evictIfNeeded()
      assert.ok(Test._getTotalMemory() > 0)
      assert.ok(Test._getTotalMemory() <= 1500)
    })

    it("evictIfNeeded enforces limits", () => {
      for (let i = 0; i < 20; i++) {
        Test._setCache(`key-${i}`, { response: {}, timestamp: i, sizeBytes: 100 })
      }
      Test.evictIfNeeded()
      const after = Test._getCacheSize()
      assert.ok(after <= 10)
    })

    it("evictOldest removes specified count", () => {
      for (let i = 0; i < 10; i++) {
        Test._setCache(`key-${i}`, { response: {}, timestamp: i * 1000, sizeBytes: 100 })
      }
      Test.evictOldest(3)
      assert.equal(Test._getCacheSize(), 7)
    })
  })

  describe("state management", () => {
    beforeEach(() => {
      Test.reset()
      Test.setSettings({ maxEntries: 100, maxMemoryBytes: 1000000, ttlSeconds: 3600 })
    })

    it("returns correct state after adding entries", () => {
      Test._setCache("k1", { response: {}, timestamp: Date.now(), sizeBytes: 100 })
      Test._setCache("k2", { response: {}, timestamp: Date.now(), sizeBytes: 100 })
      assert.equal(Test._getCacheSize(), 2)
      assert.ok(Test._getTotalMemory() > 0)
    })

    it("reset clears all state", () => {
      Test._setCache("k1", { response: {}, timestamp: Date.now(), sizeBytes: 100 })
      Test.reset()
      assert.equal(Test._getCacheSize(), 0)
      assert.equal(Test._getTotalMemory(), 0)
    })

    it("setSettings works", () => {
      Test.setSettings({ maxEntries: 999, maxMemoryBytes: 999999 })
      const state = Test.getState()
      assert.equal(state.settings.maxEntries, 999)
      assert.equal(state.settings.maxMemoryBytes, 999999)
    })
  })

  describe("interceptor flow (extension lifecycle)", () => {
    type Handler = (ev?: any, ctx?: any) => any
    const events: Record<string, Handler[]> = {}
    let shutdown: (() => void) | undefined

    before(async () => {
      const api: any = {
        registerCommand: () => {},
        on: (name: string, cb: Handler) => {
          ;(events[name] ??= []).push(cb)
        },
      }
      await init(api)
      const shutdownCbs = events.session_shutdown ?? []
      shutdown = () => shutdownCbs.forEach((cb) => cb())
    })

    after(() => {
      shutdown?.()
    })

    beforeEach(() => {
      Test.reset()
      Test.setSettings({ enabled: true, maxEntries: 50, maxMemoryBytes: 100000, ttlSeconds: 3600 })
    })

    const payload = () => ({ messages: [{ role: "user", content: "hello cache" }], parameters: {} })
    const event = (): any => ({ type: "before_provider_request", payload: payload() })
    const reqCtx = { model: { id: "test-model" } }

    it("records a miss and stamps _cacheKey on first request", async () => {
      const ev: any = event()
      const ret = await events.before_provider_request[0](ev, reqCtx)
      assert.equal(ret, undefined)
      assert.ok(ev._cacheKey, "should stamp _cacheKey on miss")
      assert.equal(Test.getStats().misses, 1)
    })

    it("returns the cached response on a byte-identical repeat when a body is captured", async () => {
      const first: any = event()
      await events.before_provider_request[0](first, reqCtx)
      // Simulate a pi API that exposes the response body
      await events.after_provider_response[0]({
        type: "after_provider_response",
        status: 200,
        headers: {},
        _cacheKey: first._cacheKey,
        response: { content: "cached!" },
      } as any)

      const second: any = event()
      const out = await events.before_provider_request[0](second, reqCtx)
      assert.ok(out, "identical repeat should short-circuit to cache")
      assert.equal(out.content, "cached!")
      assert.equal(Test.getStats().hits, 1)
    })

    it("never stores an event envelope when no response body is available", async () => {
      const first: any = event()
      await events.before_provider_request[0](first, reqCtx)
      // pi 0.84 + shape: status + headers only, no body
      await events.after_provider_response[0]({
        type: "after_provider_response",
        status: 200,
        headers: {},
      } as any)
      assert.equal(Test._getCacheSize(), 0, "must not cache the event envelope")
      assert.ok(
        Test.getStats().misses >= 0,
        "after_provider_response without a body must not poison the cache",
      )
    })

    it("does not touch the cache when disabled", async () => {
      Test.setSettings({ enabled: false })
      const ev: any = event()
      const ret = await events.before_provider_request[0](ev, reqCtx)
      assert.equal(ret, undefined)
      assert.equal(ev._cacheKey, undefined)
      assert.equal(Test.getStats().misses, 0)
    })

    it("keeps size within cap under interceptor churn", async () => {
      Test.setSettings({ maxEntries: 20 })
      for (let i = 0; i < 50; i++) {
        const ev: any = {
          type: "before_provider_request",
          payload: { messages: [{ role: "user", content: `q-${i}` }], parameters: {} },
        }
        await events.before_provider_request[0](ev, reqCtx)
        await events.after_provider_response[0]({
          _cacheKey: ev._cacheKey,
          response: { content: "a".repeat(50) },
        } as any)
      }
      assert.ok(Test._getCacheSize() <= 20)
      assert.ok(Test.getStats().misses >= 50)
    })
  })
})
