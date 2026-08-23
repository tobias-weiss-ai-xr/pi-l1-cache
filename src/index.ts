// L1 Cache Extension — in-memory response cache for pi
//
// Stoic Unix principle: One thing, done well.
// Optimized for minimal CPU/RAM overhead.
//
// Architecture:
//   pi → [L1: RAM Map] → [L2: Redis via LiteLLM] → Provider
//   Lookup: ~0.1ms  (vs 150ms Redis, 1-3s API)
//
// Design goals:
//   - Fast string hash (FNV-1a) — ~100x faster than SHA256
//   - Hard memory cap — never lets RAM bloat
//   - TTL + LRU eviction
//   - CPU-aware graceful degradation
//   - Zero dependencies, single file

import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent"

type AfterProviderResponseEvent = Extract<ExtensionEvent, { type: "after_provider_response" }>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
  response: unknown
  timestamp: number
  sizeBytes: number
}

interface Settings {
  enabled: boolean
  maxEntries: number
  maxMemoryBytes: number
  ttlSeconds: number
  cpuThreshold: number
  logStats: boolean
}

interface Stats {
  hits: number
  misses: number
  evictions: number
  cpuSkips: number
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULTS: Settings = {
  enabled: true,
  maxEntries: 200,
  maxMemoryBytes: 20 * 1024 * 1024, // 20MB
  ttlSeconds: 3600,
  cpuThreshold: 95,
  logStats: false,
}

// Users can override via environment variables (highest priority)
function envSettings(): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (process.env.L1_CACHE_ENABLED !== undefined) out.enabled = process.env.L1_CACHE_ENABLED !== "false"
  if (process.env.L1_CACHE_MAX_ENTRIES) out.maxEntries = parseInt(process.env.L1_CACHE_MAX_ENTRIES, 10) || DEFAULTS.maxEntries
  if (process.env.L1_CACHE_MAX_MB) out.maxMemoryBytes = (parseInt(process.env.L1_CACHE_MAX_MB, 10) || 20) * 1024 * 1024
  if (process.env.L1_CACHE_TTL) out.ttlSeconds = parseInt(process.env.L1_CACHE_TTL, 10) || DEFAULTS.ttlSeconds
  if (process.env.L1_CACHE_LOG) out.logStats = process.env.L1_CACHE_LOG === "true"
  return out
}

const settings: Settings = { ...DEFAULTS, ...envSettings() }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cache = new Map<string, CacheEntry>()
let totalMemory = 0
let initialCpuLoad = 0
let initialCpuStatus: "ok" | "disabled" | "error" = "ok"
let lastCleanup = Date.now()
const stats: Stats = { hits: 0, misses: 0, evictions: 0, cpuSkips: 0 }

// Capability flags (learned at runtime, never assumed):
// `canServe` turns true only after we capture a real response body, and gates
// short-circuiting so we never replace the outgoing request payload with garbage.
let canServe = false
let bodyWarningShown = false

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/** Fast string hash (FNV-1a) — ~100x faster than SHA256, enough for cache keys */
function fastHash(str: string): string {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash.toString(16)
}

/** Estimate in-memory size of an arbitrary object (UTF-16 overhead ×2) */
function estimateSize(obj: unknown): number {
  try {
    const json = JSON.stringify(obj)
    if (json === undefined) return 64 // undefined/unserializable primitive
    return json.length * 2
  } catch {
    return 1024 // fallback for non-serializable
  }
}

function log(...args: unknown[]) {
  if (settings.logStats) console.log("[l1-cache]", ...args)
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

function evictOldest(count: number) {
  if (count <= 0) return
  const sorted = Array.from(cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)
  for (let i = 0; i < Math.min(count, sorted.length); i++) {
    const [key, entry] = sorted[i]
    totalMemory -= entry.sizeBytes
    cache.delete(key)
    stats.evictions++
  }
}

/** Enforce size and memory caps using LRU-style (oldest-first) eviction */
function evictIfNeeded() {
  while (cache.size > settings.maxEntries) {
    evictOldest(Math.max(1, Math.ceil(settings.maxEntries * 0.1)))
  }
  while (totalMemory > settings.maxMemoryBytes) {
    evictOldest(Math.max(1, Math.ceil(settings.maxEntries * 0.2)))
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
  lastCleanup = now
}

// ---------------------------------------------------------------------------
// CPU check (once at startup — not per-request, to avoid overhead)
// ---------------------------------------------------------------------------

async function checkInitialCpuLoad(): Promise<number> {
  try {
    const { execSync } = await import("child_process")
    if (process.platform === "win32") {
      const out = execSync("wmic cpu get loadpercentage /value", { encoding: "utf8", timeout: 2000 })
      const match = out.match(/LoadPercentage\s*:\s*(\d+)/)
      return match ? parseInt(match[1], 10) : 0
    }
    const out = execSync("cat /proc/loadavg", { encoding: "utf8", timeout: 2000 })
    const { cpus } = await import("os")
    const cores = cpus().length
    const load = parseFloat(out.split(" ")[0])
    return Math.min(100, (load / cores) * 100)
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Tests (self-check on load — see also src/index.test.ts)
// ---------------------------------------------------------------------------

export function _testHooks() {
  return {
    fastHash,
    estimateSize,
    evictIfNeeded,
    cleanupExpired,
    evictOldest,
    getStats: () => ({ ...stats }),
    getState: () => ({ size: cache.size, totalMemory, settings: { ...settings } }),
    reset: () => {
      cache = new Map()
      totalMemory = 0
      stats.hits = 0
      stats.misses = 0
      stats.evictions = 0
      stats.cpuSkips = 0
    },
    _setCache: (key: string, entry: CacheEntry) => {
      cache.set(key, entry)
      totalMemory += entry.sizeBytes
    },
    _getCacheSize: () => cache.size,
    _getTotalMemory: () => totalMemory,
    setSettings: (patch: Partial<Settings>) => Object.assign(settings, patch),
  }
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  // Async init: check CPU once at startup
  try {
    initialCpuLoad = await checkInitialCpuLoad()
    if (initialCpuLoad > settings.cpuThreshold) {
      settings.enabled = false
      initialCpuStatus = "disabled"
      console.log(
        `[l1-cache] disabled (CPU ${initialCpuLoad.toFixed(0)}% > ${settings.cpuThreshold}% threshold)`,
      )
    } else {
      initialCpuStatus = "ok"
      console.log(
        `[l1-cache] enabled (max ${settings.maxEntries} entries, ${(settings.maxMemoryBytes / 1024 / 1024).toFixed(0)}MB, TTL ${settings.ttlSeconds}s)`,
      )
    }
  } catch (err) {
    initialCpuStatus = "error"
    console.log(`[l1-cache] CPU check failed (${err}); continuing enabled`)
  }

  // Periodic cleanup (every 10 minutes)
  const cleanupTimer = setInterval(cleanupExpired, 10 * 60 * 1000)
  pi.on("session_shutdown", () => clearInterval(cleanupTimer))

  // Interceptor: cache lookup before provider request
  pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx) => {
    if (!settings.enabled) return

    const model = ctx.model?.id || "unknown"
    // pi passes the assembled provider request as `event.payload`
    const payload = event.payload as
      | { messages?: unknown[]; parameters?: unknown }
      | null
      | undefined
    const messages = payload?.messages ?? []
    const params = payload?.parameters ?? {}

    // Fast hash; no per-request CPU check to stay on the hot path
    const key = fastHash(model + JSON.stringify(messages) + JSON.stringify(params))
    const entry = cache.get(key)

    if (entry && Date.now() - entry.timestamp <= settings.ttlSeconds * 1000) {
      stats.hits++
      // Only replace the payload when we have actually captured a response body.
      // Without one (pi 0.84 +) a return value would overwrite the outgoing
      // request payload instead of short-circuiting — so we count the hit and
      // leave the request untouched.
      if (canServe) return entry.response
      return
    }

    // Miss — remember the key for after_provider_response
    ;(event as unknown as { _cacheKey?: string })._cacheKey = key
    stats.misses++
  })

  // Interceptor: store response after provider finishes
  pi.on("after_provider_response", async (event: AfterProviderResponseEvent) => {
    if (!settings.enabled) return

    // pi 0.84 + exposes only { status, headers } here — no response body.
    // Guard so we never cache the event envelope as if it were a response.
    const e = event as unknown as { _cacheKey?: string; response?: unknown; choices?: unknown }
    const response = e.response ?? e.choices
    if (response === undefined) {
      if (!bodyWarningShown) {
        bodyWarningShown = true
        console.log(
          "[l1-cache] note: this pi version does not expose a response body in 'after_provider_response'; " +
            "responses cannot be cached. Stats remain available via /l1-cache.",
        )
      }
      return
    }
    if (!e._cacheKey) return

    const key = e._cacheKey
    const size = estimateSize(response)
    canServe = true

    cache.set(key, { response, timestamp: Date.now(), sizeBytes: size })
    totalMemory += size
    evictIfNeeded()
  })

  // Commands
  pi.registerCommand("l1-cache", {
    description: "Show L1 cache stats, or use 'clear' to reset",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = (args ?? "").trim()

      if (arg === "clear") {
        cache.clear()
        totalMemory = 0
        stats.hits = 0
        stats.misses = 0
        stats.evictions = 0
        ctx.ui.notify("L1 cache cleared", "info")
        return
      }

      if (arg === "stats" || arg === "") {
        const hitRate =
          stats.hits + stats.misses > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) : "0.0"
        const lines = [
          `L1 cache status: ${settings.enabled ? "ENABLED" : "disabled"}`,
          `Response caching: ${canServe ? "active" : "unavailable (no response body in this pi API)"}`,
          `Entries: ${cache.size} / ${settings.maxEntries}`,
          `Memory: ${(totalMemory / 1024 / 1024).toFixed(1)}MB / ${(settings.maxMemoryBytes / 1024 / 1024).toFixed(1)}MB`,
          `TTL: ${settings.ttlSeconds}s | CPU threshold: ${settings.cpuThreshold}%`,
          `Hits: ${stats.hits} | Misses: ${stats.misses} | Evictions: ${stats.evictions}`,
          `Hit rate: ${hitRate}%`,
          `Init CPU: ${initialCpuLoad.toFixed(1)}% (${initialCpuStatus})`,
          `Last cleanup: ${new Date(lastCleanup).toISOString()}`,
        ]
        ctx.ui.notify(lines.join("\n"), "info")
        return
      }

      if (arg === "enable") {
        settings.enabled = true
        ctx.ui.notify("L1 cache enabled", "info")
        return
      }

      if (arg === "disable") {
        settings.enabled = false
        ctx.ui.notify("L1 cache disabled", "info")
        return
      }

      ctx.ui.notify(`Unknown command: /l1-cache ${arg}\nUsage: /l1-cache [stats|clear|enable|disable]`, "error")
    },
  })

  console.log("[l1-cache] ready. /l1-cache for stats.")
}
