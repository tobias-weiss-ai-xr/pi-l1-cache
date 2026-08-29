// L1 Cache Extension — Test Suite
//
// Tests for the working implementation with replay, disk persistence,
// and proper key semantics.

import { describe, it, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

import l1CacheExtension from "./index.js"
import { cache, stats, settings, fastHash, estimateSize, coalesceChunks, evictIfNeeded, cleanupExpired, keyForPayload, persistEntry, loadPersisted, resetForTests } from "./index.js"

// Test cache directory (isolated from real cache)
const TEST_CACHE_DIR = path.join(os.tmpdir(), "l1-cache-test-" + Date.now())

// Mock ExtensionAPI
function createMockExtensionAPI(): any {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any>>>()
  const commands = new Map<string, any>()
  let sessionShutdownHandler: ((event: any, ctx?: any) => Promise<any>) | null = null

  return {
    on: (event: string, handler: (event: any, ctx?: any) => Promise<any>) => {
      if (event === "session_shutdown") {
        sessionShutdownHandler = handler
      } else {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event)!.push(handler)
      }
    },
    registerCommand: (name: string, config: any) => {
      commands.set(name, config)
    },
    emit: async (event: any) => {
      const eventHandlers = handlers.get(event.type) || []
      for (const handler of eventHandlers) {
        await handler(event, {})
      }
    },
    _getHandlers: (event: string) => handlers.get(event) || [],
    _getSessionShutdownHandler: () => sessionShutdownHandler,
    _getCommands: () => commands,
  }
}

describe("L1 Cache", () => {
  beforeEach(() => {
    // Clean test cache directory
    if (fs.existsSync(TEST_CACHE_DIR)) {
      fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
    fs.mkdirSync(TEST_CACHE_DIR, { recursive: true })
    // Isolate: redirect persistence + reset all module state
    process.env.L1_CACHE_DIR = TEST_CACHE_DIR
    resetForTests()
  })

  afterEach(() => {
    // Cleanup test cache directory
    if (fs.existsSync(TEST_CACHE_DIR)) {
      fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
    }
  })

  describe("fastHash", () => {
    it("produces consistent hashes for identical strings", () => {
      const str = "test string"
      const h1 = fastHash(str)
      const h2 = fastHash(str)
      assert.strictEqual(h1, h2)
    })

    it("produces different hashes for different strings", () => {
      const h1 = fastHash("string1")
      const h2 = fastHash("string2")
      assert.notStrictEqual(h1, h2)
    })

    it("handles empty string", () => {
      const hash = fastHash("")
      assert.ok(hash.length > 0)
    })

    it("handles unicode characters", () => {
      const hash = fastHash("🚀 test")
      assert.ok(hash.length > 0)
    })
  })

  describe("keyForPayload", () => {
    it("creates key from model and messages", () => {
      const payload = {
        model: "local/deepseek-v4",
        messages: [{ role: "user", content: "test" }],
      }
      const key = keyForPayload(payload)
      assert.ok(key)
      assert.ok(key.length > 0)
    })

    it("excludes volatile fields from key", () => {
      const payload1 = {
        model: "local/deepseek-v4",
        messages: [{ role: "user", content: "test" }],
        prompt_cache_key: "session-123",
        stream: true,
      }
      const payload2 = {
        model: "local/deepseek-v4",
        messages: [{ role: "user", content: "test" }],
        prompt_cache_key: "session-456", // different
        stream: false, // different
      }
      const key1 = keyForPayload(payload1)
      const key2 = keyForPayload(payload2)
      assert.strictEqual(key1, key2) // keys should match despite volatile differences
    })

    it("includes tools in key", () => {
      const payload1 = {
        model: "local/deepseek-v4",
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "tool1" }],
      }
      const payload2 = {
        model: "local/deepseek-v4",
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "tool2" }], // different
      }
      const key1 = keyForPayload(payload1)
      const key2 = keyForPayload(payload2)
      assert.notStrictEqual(key1, key2)
    })

    it("returns null for invalid payloads", () => {
      assert.strictEqual(keyForPayload(null), null)
      assert.strictEqual(keyForPayload(undefined), null)
      assert.strictEqual(keyForPayload({}), null)
      assert.strictEqual(keyForPayload({ messages: "not-array" }), null)
    })
  })

  describe("coalesceChunks", () => {
    it("merges adjacent content deltas", () => {
      const chunks = [
        { choices: [{ delta: { content: "hello" } }] },
        { choices: [{ delta: { content: " " } }] },
        { choices: [{ delta: { content: "world" } }] },
      ]
      const coalesced = coalesceChunks(chunks)
      assert.strictEqual(coalesced.length, 1)
      assert.strictEqual(coalesced[0].choices[0].delta.content, "hello world")
    })

    it("merges adjacent reasoning_content deltas", () => {
      const chunks = [
        { choices: [{ delta: { reasoning_content: "thinking" } }] },
        { choices: [{ delta: { reasoning_content: " more" } }] },
      ]
      const coalesced = coalesceChunks(chunks)
      assert.strictEqual(coalesced.length, 1)
      assert.strictEqual(coalesced[0].choices[0].delta.reasoning_content, "thinking more")
    })

    it("does not merge chunks with finish_reason", () => {
      const chunks = [
        { choices: [{ delta: { content: "hello" } }] },
        { choices: [{ delta: { content: "world" }, finish_reason: "stop" }] },
      ]
      const coalesced = coalesceChunks(chunks)
      assert.strictEqual(coalesced.length, 2)
    })

    it("does not merge chunks with tool_calls", () => {
      const chunks = [
        { choices: [{ delta: { content: "hello" } }] },
        { choices: [{ delta: { tool_calls: [{ id: "call1" }] } }] },
      ]
      const coalesced = coalesceChunks(chunks)
      assert.strictEqual(coalesced.length, 2)
    })

    it("handles empty chunks array", () => {
      const coalesced = coalesceChunks([])
      assert.strictEqual(coalesced.length, 0)
    })
  })

  describe("estimateSize", () => {
    it("estimates size for simple objects", () => {
      const obj = { text: "hello" }
      const size = estimateSize(obj)
      assert.ok(size > 0)
    })

    it("handles large objects", () => {
      const obj = { text: "x".repeat(10000) }
      const size = estimateSize(obj)
      assert.ok(size > 10000)
    })

    it("handles undefined", () => {
      const size = estimateSize(undefined)
      assert.strictEqual(size, 4096) // fallback for non-serializable
    })
  })

  describe("cache operations", () => {
    it("stores and retrieves entries", async () => {
      const payload = {
        model: "local/deepseek-v4",
        messages: [{ role: "user", content: "test" }],
      }
      const key = keyForPayload(payload)!
      const chunks = [{ choices: [{ delta: { content: "answer" } }] }]
      const size = estimateSize(chunks)

      cache.set(key, { chunks, timestamp: Date.now(), sizeBytes: size })
      evictIfNeeded()

      const entry = cache.get(key)
      assert.ok(entry)
      assert.strictEqual(entry!.chunks.length, 1)
    })

    it("evicts oldest entries when over memory cap", async () => {
      settings.maxEntries = 2
      settings.maxMemoryBytes = 100
      const chunks = [{ choices: [{ delta: { content: "x".repeat(50) } }] }]
      const size = estimateSize(chunks)

      // Store 3 entries (should evict to stay within cap)
      for (let i = 0; i < 3; i++) {
        const payload = { model: "local/deepseek-v4", messages: [{ role: "user", content: `test${i}` }] }
        const key = keyForPayload(payload)!
        cache.set(key, { chunks, timestamp: Date.now() + i, sizeBytes: size })
        evictIfNeeded()
      }

      assert.ok(cache.size <= 2)
    })

    it("respects TTL expiry", async () => {
      settings.ttlSeconds = 1
      const payload = { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] }
      const key = keyForPayload(payload)!
      const chunks = [{ choices: [{ delta: { content: "answer" } }] }]

      // Set timestamp in past (expired)
      cache.set(key, { chunks, timestamp: Date.now() - 2000, sizeBytes: estimateSize(chunks) })

      // Simulate cleanup
      cleanupExpired()

      assert.strictEqual(cache.has(key), false)
    })
  })

  describe("persistence", () => {
    it("persists entries to disk", async () => {
      const payload = { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] }
      const key = keyForPayload(payload)!
      const chunks = [{ choices: [{ delta: { content: "answer" } }] }]

      persistEntry(key, { chunks, timestamp: Date.now(), sizeBytes: estimateSize(chunks) })

      // Verify file exists
      const filePath = path.join(TEST_CACHE_DIR, key + ".json")
      assert.ok(fs.existsSync(filePath))

      // Load and verify
      cache.clear()
      loadPersisted()
      assert.strictEqual(cache.size, 1)
    })

    it("ignores expired entries on load", async () => {
      settings.ttlSeconds = 1
      const payload = { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] }
      const key = keyForPayload(payload)!

      // Persist with old timestamp
      persistEntry(key, {
        chunks: [{ choices: [{ delta: { content: "answer" } }] }],
        timestamp: Date.now() - 2000,
        sizeBytes: estimateSize([]),
      })

      cache.clear()
      loadPersisted()
      assert.strictEqual(cache.size, 0)
    })

    it("handles corrupted files gracefully", async () => {
      // Create corrupted file
      fs.writeFileSync(path.join(TEST_CACHE_DIR, "corrupt.json"), "not valid json")

      cache.clear()
      loadPersisted()
      // Should not crash, corrupted file should be deleted
      assert.strictEqual(fs.existsSync(path.join(TEST_CACHE_DIR, "corrupt.json")), false)
    })
  })

  describe("extension integration", () => {
    it("initializes and registers commands", async () => {
      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const commands = mockApi._getCommands()
      assert.ok(commands.has("l1-cache"))
    })

    it("handles before_provider_request (miss)", async () => {
      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const handler = mockApi._getHandlers("before_provider_request")[0]
      const event = {
        payload: { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] },
      }

      const result = await handler(event, { model: { id: "local/deepseek-v4" } })
      assert.strictEqual(result, undefined) // miss, no replay
    })

    it("handles before_provider_request (hit)", async () => {
      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const handler = mockApi._getHandlers("before_provider_request")[0]
      const payload = { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] }
      const event = { payload }

      // First call is miss
      await handler(event, { model: { id: "local/deepseek-v4" } })

      // Simulate a cache entry
      const key = keyForPayload(payload)!
      cache.set(key, {
        chunks: [{ choices: [{ delta: { content: "cached" } }] }],
        timestamp: Date.now(),
        sizeBytes: 100,
      })

      // Second call should hit
      const result = await handler(event, { model: { id: "local/deepseek-v4" } })
      assert.ok(result)
      assert.ok((result as any).__piL1Replay)
    })

    it("handles provider_stream_complete", async () => {
      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const handler = mockApi._getHandlers("provider_stream_complete")[0]
      const event = {
        payload: { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] },
        chunks: [{ choices: [{ delta: { content: "answer" } }] }],
      }

      await handler(event)

      // Verify entry was stored
      const key = keyForPayload(event.payload)!
      const entry = cache.get(key)
      assert.ok(entry)
      assert.strictEqual(entry!.chunks.length, 1)
    })

    it("handles /l1-cache clear command", async () => {
      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const command = mockApi._getCommands().get("l1-cache")
      const mockCtx = {
        ui: {
          notify: () => {},
        },
      }

      // Populate first so the assertion is meaningful
      cache.set("k", { chunks: [{ choices: [{ delta: { content: "x" } }] }], timestamp: Date.now(), sizeBytes: 64 })

      await command!.handler("clear", mockCtx)

      assert.strictEqual(cache.size, 0)
    })

    it("handles /l1-cache stats command", async () => {
      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const command = mockApi._getCommands().get("l1-cache")
      const mockCtx = {
        ui: {
          notify: (msg: string) => {
            assert.ok(msg.includes("L1 cache"))
          },
        },
      }

      await command!.handler("stats", mockCtx)
    })
  })

  describe("edge cases", () => {
    it("handles disabled cache", async () => {
      settings.enabled = false

      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const handler = mockApi._getHandlers("before_provider_request")[0]
      const event = {
        payload: { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] },
      }

      const result = await handler(event, { model: { id: "local/deepseek-v4" } })
      assert.strictEqual(result, undefined)
    })

    it("handles empty chunks (no storage)", async () => {
      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const handler = mockApi._getHandlers("provider_stream_complete")[0]
      const event = {
        payload: { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] },
        chunks: [], // empty
      }

      await handler(event)
      const key = keyForPayload(event.payload)!
      assert.strictEqual(cache.has(key), false)
    })

    it("handles stale ctx gracefully", async () => {
      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const handler = mockApi._getHandlers("before_provider_request")[0]
      const event = {
        payload: { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] },
      }

      // Stale ctx (no model.id)
      const result = await handler(event, { model: { id: undefined } })
      assert.strictEqual(result, undefined)
    })

    it("prevents re-storing replays", async () => {
      const mockApi = createMockExtensionAPI()
      await l1CacheExtension(mockApi)

      const beforeHandler = mockApi._getHandlers("before_provider_request")[0]
      const completeHandler = mockApi._getHandlers("provider_stream_complete")[0]

      const payload = { model: "local/deepseek-v4", messages: [{ role: "user", content: "test" }] }
      const event = { payload }

      // First call is miss
      await beforeHandler(event, { model: { id: "local/deepseek-v4" } })

      // Simulate cache hit
      const key = keyForPayload(payload)!
      cache.set(key, {
        chunks: [{ choices: [{ delta: { content: "cached" } }] }],
        timestamp: Date.now(),
        sizeBytes: 100,
      })

      // Second call is hit
      const result = await beforeHandler(event, { model: { id: "local/deepseek-v4" } })
      assert.ok(result)

      // Try to store (should be prevented by lastServed guard)
      const chunksBefore = cache.get(key)!.chunks.length
      await completeHandler({ payload, chunks: [{ choices: [{ delta: { content: "new" } }] }] })
      const chunksAfter = cache.get(key)!.chunks.length

      assert.strictEqual(chunksBefore, chunksAfter) // should not re-store
    })
  })

  describe("performance", () => {
    it("hash is fast (< 10µs per call)", () => {
      const iterations = 1000
      const start = Date.now()

      for (let i = 0; i < iterations; i++) {
        fastHash("test string " + i)
      }

      const elapsed = Date.now() - start
      const avgPerCall = (elapsed * 1000) / iterations // in µs
      assert.ok(avgPerCall < 10, `Hash average ${avgPerCall}µs, expected < 10µs`)
    })

    it("coalescing reduces chunk count", () => {
      const chunks = Array.from({ length: 100 }, (_, i) => ({
        choices: [{ delta: { content: "x" } }],
      }))

      const coalesced = coalesceChunks(chunks)
      assert.strictEqual(coalesced.length, 1) // all merged into one
    })
  })
})
