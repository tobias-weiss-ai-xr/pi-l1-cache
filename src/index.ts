/**
 * L1 Cache Extension — in-memory response cache for pi
 *
 * Stoic Unix principle: One thing, done well.
 * Optimized for minimal CPU/RAM overhead.
 *
 * Architecture:
 *   pi → [L1: RAM Map] → [L2: Redis via LiteLLM] → Provider
 *   Lookup: ~0.1ms (vs 150ms Redis, 1-3s API)
 *
 * Optimizations:
 *   - Fast string hash (not SHA256) — ~100x faster
 *   - Hard memory cap (50MB max)
 *   - Size-based + age-based eviction
 *   - CPU-aware: skips cache if load > 80%
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface CacheEntry {
  response: any;
  timestamp: number;
  sizeBytes: number;
}

interface Settings {
  enabled: boolean;
  maxEntries: number;
  maxMemoryBytes: number;  // 50MB default
  ttlSeconds: number;
  cpuThreshold: number;     // skip cache if load > this
  logStats: boolean;
}

const DEFAULTS: Settings = {
  enabled: true,
  maxEntries: 200,          // reduced from 500 (L1 is hot path)
  maxMemoryBytes: 20 * 1024 * 1024,  // 20MB (reduced from 50MB)
  ttlSeconds: 3600,
  cpuThreshold: 95,         // raised from 80% (only skip under extreme load)
  logStats: false,          // disabled (reduces I/O overhead)
};

let cache = new Map<string, CacheEntry>();
let totalMemory = 0;
let stats = { hits: 0, misses: 0, evictions: 0, cpuSkips: 0 };
let settings: Settings = DEFAULTS;
let lastCleanup = Date.now();

// Fast string hash (FNV-1a variant) — ~100x faster than SHA256
function fastHash(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash.toString(16);
}

function estimateSize(obj: any): number {
  // Rough estimate: JSON string length * 2 (UTF-16 overhead)
  try { return JSON.stringify(obj).length * 2; }
  catch { return 1024; }  // fallback
}

function evictOldest(count: number) {
  if (count <= 0) return;
  const sorted = Array.from(cache.entries())
    .sort((a, b) => a[1].timestamp - b[1].timestamp);
  for (let i = 0; i < Math.min(count, sorted.length); i++) {
    const [key, entry] = sorted[i];
    totalMemory -= entry.sizeBytes;
    cache.delete(key);
    stats.evictions++;
  }
}

function evictIfNeeded() {
  // Size-based eviction
  while (cache.size > settings.maxEntries) {
    evictOldest(Math.ceil(settings.maxEntries * 0.1));
  }
  // Memory-based eviction
  while (totalMemory > settings.maxMemoryBytes) {
    evictOldest(Math.ceil(settings.maxEntries * 0.2));
  }
}

function cleanupExpired() {
  const now = Date.now();
  let expired = 0;
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > settings.ttlSeconds * 1000) {
      totalMemory -= entry.sizeBytes;
      cache.delete(key);
      expired++;
    }
  }
  if (expired > 0 && settings.logStats) log(`expired ${expired} entries`);
}

// CPU check: only on init (not per-request to avoid overhead)
let initialCpuLoad = 0;
async function checkInitialCpuLoad(): Promise<number> {
  try {
    if (process.platform === "win32") {
      const { execSync } = await import("child_process");
      const out = execSync("wmic cpu get loadpercentage /value", { encoding: "utf8", timeout: 2000 });
      const match = out.match(/LoadPercentage\s*:\s*(\d+)/);
      return match ? parseInt(match[1]) : 0;
    } else {
      const { execSync } = await import("child_process");
      const out = execSync("cat /proc/loadavg", { encoding: "utf8", timeout: 2000 });
      const cores = require("os").cpus().length;
      const load = parseFloat(out.split(" ")[0]);
      return Math.min(100, (load / cores) * 100);
    }
  } catch {
    return 0;
  }
}

function log(...args: any[]) {
  if (settings.logStats) console.log("[l1-cache]", ...args);
}

export default async function (pi: ExtensionAPI) {
  // Async init: check CPU once at startup (not per-request)
  initialCpuLoad = await checkInitialCpuLoad();
  if (initialCpuLoad > settings.cpuThreshold) {
    settings.enabled = false;
    console.log("[l1-cache] disabled (CPU", initialCpuLoad + "% >", settings.cpuThreshold + "% threshold)");
  } else {
    console.log("[l1-cache] enabled (max", settings.maxEntries, "entries,", (settings.maxMemoryBytes / 1024 / 1024).toFixed(0) + "MB, TTL", settings.ttlSeconds + "s)");
  }

  // Periodic cleanup (every 10 minutes — L1 is volatile anyway)
  const cleanupTimer = setInterval(cleanupExpired, 10 * 60 * 1000);
  pi.on("session_shutdown", () => clearInterval(cleanupTimer));

  // Interceptor: before_provider_request
  pi.on("before_provider_request", async (event, ctx) => {
    if (!settings.enabled) return;

    const model = ctx.model?.id || "unknown";
    const messages = event.messages || [];
    const params = event.parameters || {};

    // Fast hash (no per-request CPU check)
    const key = fastHash(model + JSON.stringify(messages) + JSON.stringify(params));
    const entry = cache.get(key);

    // Cache hit
    if (entry && Date.now() - entry.timestamp <= settings.ttlSeconds * 1000) {
      stats.hits++;
      return entry.response;  // instant response
    }

    // Cache miss — stash key for later
    event._cacheKey = key;
    stats.misses++;
  });

  // Interceptor: after_provider_response
  pi.on("after_provider_response", async (event, ctx) => {
    if (!settings.enabled) return;
    if (!event._cacheKey) return;

    const key = event._cacheKey;
    const response = event.response || event.choices || event;
    const size = estimateSize(response);

    // Store in cache
    cache.set(key, {
      response,
      timestamp: Date.now(),
      sizeBytes: size,
    });
    totalMemory += size;

    evictIfNeeded();
  });

  // Commands for inspection
  pi.registerCommand("l1-cache", {
    description: "L1 cache stats and management",
    handler: async (args, ctx) => {
      if (args === "clear") {
        cache.clear();
        totalMemory = 0;
        ctx.ui.notify("L1 cache cleared", "success");
        return;
      }
      const hitRate = stats.hits + stats.misses > 0
        ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)
        : 0;
      ctx.ui.notify(
        `L1: ${cache.size}/${settings.maxEntries} | ${(totalMemory/1024/1024).toFixed(1)}MB | Hits: ${stats.hits} | Misses: ${stats.misses} | Rate: ${hitRate}% | Init CPU: ${initialCpuLoad}%`,
        "info"
      );
    },
  });

  console.log("[l1-cache] ready. /l1-cache for stats.");
}
