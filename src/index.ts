// L1 Cache Extension — response cache for pi (working implementation)
//
// Architecture:
//   pi → [L1: RAM Map + disk (~/.pi/agent/cache/l1-cache)] → Provider
//
// How it works (requires the fix-l1-cache.js pi patches):
//   - "provider_stream_complete" (new event, patched into sdk.js) delivers the
//     raw OpenAI stream chunks + request params after a successful completion.
//   - On a cache hit, "before_provider_request" returns the original payload
//     with a __piL1Replay marker; the patched pi-ai stream() feeds the cached
//     chunks through the normal consume path and never contacts the provider.
//
// Key: stable hash of model + messages + tools + sampling fields.
// Volatile fields (prompt_cache_key, session ids, stream flags) are excluded.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

interface CacheEntry {
  chunks: any[]
  timestamp: number
  sizeBytes: number
}

interface Settings {
  enabled: boolean
  maxEntries: number
  maxMemoryBytes: number
  ttlSeconds: number
  persist: boolean
  logStats: boolean
}

const DEFAULTS: Settings = {
  enabled: true,
  maxEntries: 200,
  maxMemoryBytes: 20 * 1024 * 1024, // 20MB
  ttlSeconds: 3600,
  persist: true,
  logStats: false,
}

/** Cache directory (overridable via L1_CACHE_DIR env for tests) */
function cacheDir(): string {
  return process.env.L1_CACHE_DIR || path.join(os.homedir(), ".pi", "agent", "cache", "l1-cache")
}

/** Users can override via environment variables (highest priority) */
function envSettings(): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (process.env.L1_CACHE_ENABLED !== undefined) out.enabled = process.env.L1_CACHE_ENABLED !== "false"
  if (process.env.L1_CACHE_MAX_ENTRIES) out.maxEntries = parseInt(process.env.L1_CACHE_MAX_ENTRIES, 10) || DEFAULTS.maxEntries
  if (process.env.L1_CACHE_MAX_MB) out.maxMemoryBytes = (parseInt(process.env.L1_CACHE_MAX_MB, 10) || 20) * 1024 * 1024
  if (process.env.L1_CACHE_TTL) out.ttlSeconds = parseInt(process.env.L1_CACHE_TTL, 10) || DEFAULTS.ttlSeconds
  if (process.env.L1_CACHE_PERSIST !== undefined) out.persist = process.env.L1_CACHE_PERSIST !== "false"
  if (process.env.L1_CACHE_LOG) out.logStats = process.env.L1_CACHE_LOG === "true"
  return out
}

let cache = new Map<string, CacheEntry>()
let totalMemory = 0
let stats = { hits: 0, misses: 0, writes: 0, evictions: 0, replays: 0 }
let settings: Settings = { ...DEFAULTS, ...envSettings() }

// Guard against re-storing a response we just served from cache.
let lastServed: { key: string; at: number } | null = null

function log(...args: any[]) {
  if (settings.logStats) console.log("[l1-cache]", ...args)
}

// FNV-1a — fast, good enough for exact-match keys (collision => 1-in-billions
// and even then only identical-shape requests after JSON canonicalization).
function fastHash(str: string): string {
  let h1 = 2166136261
  let h2 = 2166136261
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ (c + i), 16777619)
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)
}

/**
 * Stable cache key from the real request payload. Only fields that change the
 * model's output are included; transport/volatile fields are excluded.
 */
function keyForPayload(payload: any): string | null {
  if (!payload || !Array.isArray(payload.messages)) return null
  const basis = {
    model: payload.model,
    messages: payload.messages,
    tools: payload.tools,
    tool_choice: payload.tool_choice,
    temperature: payload.temperature,
    top_p: payload.top_p,
    reasoning_effort: payload.reasoning_effort,
    thinking: payload.thinking,
    max_completion_tokens: payload.max_completion_tokens,
    max_tokens: payload.max_tokens,
  }
  return fastHash(JSON.stringify(basis))
}

function estimateSize(value: unknown): number {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return 4096
    return json.length * 2
  } catch {
    return 4096
  }
}

/** Merge adjacent pure-delta chunks (content / reasoning_content) to shrink storage. */
function coalesceChunks(chunks: any[]): any[] {
  const COALESCEABLE = new Set(["content", "reasoning_content", "reasoning"])
  const out: any[] = []
  for (const chunk of chunks) {
    const prev = out[out.length - 1]
    const choice = chunk?.choices?.[0]
    const prevChoice = prev?.choices?.[0]
    if (
      prev &&
      choice &&
      prevChoice &&
      choice.delta &&
      prevChoice.delta &&
      !choice.finish_reason &&
      !prevChoice.finish_reason &&
      !chunk.usage &&
      !prev.usage &&
      !choice.delta.tool_calls &&
      !prevChoice.delta.tool_calls
    ) {
      const dKeys = Object.keys(choice.delta).filter((k) => choice.delta[k] !== undefined)
      const pKeys = Object.keys(prevChoice.delta).filter((k) => prevChoice.delta[k] !== undefined)
      // each delta must be a single coalesceable string field (role allowed on the first)
      const dField = dKeys.find((k) => COALESCEABLE.has(k))
      const pField = pKeys.find((k) => COALESCEABLE.has(k))
      if (dField === undefined || pField === undefined) {
        out.push(chunk)
        continue
      }
      const dOk = dKeys.every((k) => k === dField || k === "role") && typeof choice.delta[dField] === "string"
      const pOk = pKeys.every((k) => k === pField || k === "role") && typeof prevChoice.delta[pField] === "string"
      if (dOk && pOk && dField === pField) {
        prevChoice.delta[pField] += choice.delta[dField]
        continue
      }
    }
    out.push(chunk)
  }
  return out
}

function evictIfNeeded() {
  while (cache.size > settings.maxEntries) {
    const oldest = Array.from(cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
    if (!oldest) break
    totalMemory -= oldest[1].sizeBytes
    cache.delete(oldest[0])
    stats.evictions++
    if (settings.persist) {
      try {
        fs.unlinkSync(path.join(cacheDir(), oldest[0] + ".json"))
      } catch {}
    }
  }
  while (totalMemory > settings.maxMemoryBytes) {
    const oldest = Array.from(cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
    if (!oldest) break
    totalMemory -= oldest[1].sizeBytes
    cache.delete(oldest[0])
    stats.evictions++
    if (settings.persist) {
      try {
        fs.unlinkSync(path.join(cacheDir(), oldest[0] + ".json"))
      } catch {}
    }
  }
}

function persistEntry(key: string, entry: CacheEntry) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(
      path.join(cacheDir(), key + ".json"),
      JSON.stringify({ chunks: entry.chunks, timestamp: entry.timestamp })
    )
  } catch (err) {
    log("persist failed:", (err as Error).message)
  }
}

function loadPersisted() {
  if (!settings.persist) return
  try {
    if (!fs.existsSync(cacheDir())) return
    const now = Date.now()
    for (const file of fs.readdirSync(cacheDir())) {
      if (!file.endsWith(".json")) continue
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(cacheDir(), file), "utf8"))
        if (!Array.isArray(raw.chunks) || raw.chunks.length === 0) {
          fs.unlinkSync(path.join(cacheDir(), file))
          continue
        }
        if (now - (raw.timestamp || 0) > settings.ttlSeconds * 1000) {
          fs.unlinkSync(path.join(cacheDir(), file))
          continue
        }
        const key = file.replace(/\.json$/, "")
        const sizeBytes = estimateSize(raw.chunks)
        cache.set(key, { chunks: raw.chunks, timestamp: raw.timestamp || now, sizeBytes })
        totalMemory += sizeBytes
      } catch {
        try {
          fs.unlinkSync(path.join(cacheDir(), file))
        } catch {}
      }
    }
    evictIfNeeded()
  } catch (err) {
    log("load failed:", (err as Error).message)
  }
}

/** Remove expired entries (called periodically + on access) */
function cleanupExpired() {
  const now = Date.now()
  let expired = 0
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > settings.ttlSeconds * 1000) {
      totalMemory -= entry.sizeBytes
      cache.delete(key)
      expired++
    }
  }
  if (expired > 0) log(`expired ${expired} entries`)
}

export default async function (pi: ExtensionAPI) {
  if (settings.enabled) {
    console.log(
      "[l1-cache] enabled (max",
      settings.maxEntries,
      "entries,",
      (settings.maxMemoryBytes / 1024 / 1024).toFixed(0) + "MB, TTL",
      settings.ttlSeconds + "s,",
      settings.persist ? "persisted)" : "memory-only)"
    )
    loadPersisted()
    if (cache.size > 0) log("loaded", cache.size, "entries from disk")
  } else {
    console.log("[l1-cache] disabled")
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of cache.entries()) {
      if (now - entry.timestamp > settings.ttlSeconds * 1000) {
        totalMemory -= entry.sizeBytes
        cache.delete(key)
        if (settings.persist) {
          try {
            fs.unlinkSync(path.join(cacheDir(), key + ".json"))
          } catch {}
        }
      }
    }
  }, 10 * 60 * 1000)
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref()
  pi.on("session_shutdown", () => clearInterval(cleanupTimer))

  // HIT path: serve cached chunks by replaying them through the patched
  // pi-ai stream() — the provider is never contacted.
  pi.on("before_provider_request", async (event: any, ctx) => {
    if (!settings.enabled) return

    // The runner can be stale if a provider stream outlives a session
    // replacement; skip instead of crashing on ctx access.
    try {
      if (ctx.model?.id === undefined && event.payload?.model === undefined) return
    } catch {
      return
    }

    const payload = event.payload
    const key = keyForPayload(payload)
    if (!key) return

    const entry = cache.get(key)
    if (entry && Date.now() - entry.timestamp <= settings.ttlSeconds * 1000) {
      stats.hits++
      stats.replays++
      lastServed = { key, at: Date.now() }
      entry.timestamp = Date.now() // LRU touch
      log("HIT", key, "(" + entry.chunks.length + " chunks)")
      return { ...payload, __piL1Replay: entry.chunks }
    }

    stats.misses++
    log("MISS", key)
  })

  // WRITE path: patched sdk.js emits this after a successful completion with
  // the raw stream chunks + the exact request params.
  ;(pi as any).on("provider_stream_complete", async (event: any) => {
    if (!settings.enabled) return
    const payload = event.payload
    const key = keyForPayload(payload)
    if (!key || !Array.isArray(event.chunks) || event.chunks.length === 0) return

    // Don't re-store what we just replayed from cache.
    if (lastServed && lastServed.key === key && Date.now() - lastServed.at < 10000) return

    const chunks = coalesceChunks(event.chunks)
    const sizeBytes = estimateSize(chunks)
    if (sizeBytes > settings.maxMemoryBytes / 4) return // don't cache giant single entries

    if (cache.has(key)) totalMemory -= cache.get(key)!.sizeBytes
    cache.set(key, { chunks, timestamp: Date.now(), sizeBytes })
    totalMemory += sizeBytes
    stats.writes++
    evictIfNeeded()
    if (settings.persist) persistEntry(key, cache.get(key)!)
    log("STORED", key, chunks.length, "chunks,", (sizeBytes / 1024).toFixed(1) + "KB")
  })

  // Commands for inspection
  pi.registerCommand("l1-cache", {
    description: "L1 cache stats and management",
    handler: async (args: string, ctx: any) => {
      if (args === "clear") {
        cache.clear()
        totalMemory = 0
        lastServed = null
        try {
          if (fs.existsSync(cacheDir()))
            for (const f of fs.readdirSync(cacheDir())) fs.unlinkSync(path.join(cacheDir(), f))
        } catch {}
        ctx.ui.notify("L1 cache cleared (memory + disk)", "success")
        return
      }
      const kb = (totalMemory / 1024).toFixed(1)
      ctx.ui.notify(
        `L1 cache: ${cache.size} entries, ${kb}KB | hits ${stats.hits} (replays ${stats.replays}), misses ${stats.misses}, writes ${stats.writes}, evictions ${stats.evictions} | dir: ${cacheDir()}`,
        "info"
      )
    },
  })
}

/** Reset all module state (for tests) */
export function resetForTests() {
  cache.clear()
  totalMemory = 0
  lastServed = null
  stats.hits = 0
  stats.misses = 0
  stats.writes = 0
  stats.evictions = 0
  stats.replays = 0
  Object.assign(settings, DEFAULTS, envSettings())
}

// Export internal state for testing
export { cache, totalMemory, stats, settings, cacheDir, lastServed }

// Export internal functions for testing
export { fastHash, estimateSize, coalesceChunks, evictIfNeeded, cleanupExpired, keyForPayload, persistEntry, loadPersisted }
