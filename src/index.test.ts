import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { _testHooks } from "./index.ts"

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
})
