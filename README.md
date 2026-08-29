# pi-l1-cache

> **L1 In-Memory Cache Extension for pi** — with disk persistence, response replay, and working capture

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Pi Package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)
[![npm version](https://www.npmjs.com/package/pi-l1-cache)](https://www.npmjs.com/package/pi-l1-cache)

A high-performance, production-ready **L1 (in-memory + disk) cache** extension for the [pi coding agent](https://pi.dev). Unlike the stock API which lacks response capture, this implementation uses a **pi-core patch** to enable full caching with replay.

## ⚡ Performance

| Scenario | Cold | Warm (replayed) | Speedup |
|---|---|---|---|
| Simple prompt | 3.2s | **1.9s** | ~1.7× |
| **Tool-calling agent loop** | 13.1s | **2.5s** | **5.2×** |

## Features

| Feature | Description |
|---------|-------------|
| **Response replay** | Cached chunks are fed through pi-ai's normal consume path — parsing, usage, tool-calls, stop-reason all identical |
| **Disk persistence** | Survives across `pi -p` process restarts (`~/.pi/agent/cache/l1-cache/`) |
| **~138µs overhead** | End-to-end per-request cost (measured, incl. key hashing + JSON) |
| **Fast key hash** | FNV-1a (~1.5µs/op) — no per-request CPU probe on the hot path |
| **Memory cap** | Hard limit (20MB default) prevents RAM bloat |
| **Auto-eviction** | LRU-style cleanup when limits reached |
| **TTL-based** | 1-hour default expiry for cached entries |
| **Coalescing** | Adjacent content/reasoning_content deltas merged to shrink storage |

## Architecture

```
pi → [L1: RAM Map + disk] → Provider
     ~138µs lookup          1-3s
```

The extension uses a **pi-core patch** (`fix-l1-cache.js`) to add two capabilities the stock extension API lacks:

1. **REPLAY** — an extension may serve a cached response by returning params with `__piL1Replay: [chunks]` from `before_provider_request`; pi-ai feeds the cached chunks through the normal consume path and never contacts the provider.

2. **CAPTURE** — after a successful completion, pi-ai calls `options.onStreamComplete(allChunks, requestParams)`; `sdk.js` forwards them to extensions as a `provider_stream_complete` event so the cache can store the response.

## Installation

### Option 1: From npm (recommended)

```bash
pi install npm:pi-l1-cache
```

This installs the extension AND automatically applies the `fix-l1-cache.js` pi-core patch.

### Option 2: From GitHub

```bash
pi install git:github.com:tobias-weiss-ai-xr/pi-l1-cache@main
```

### Option 3: From local clone

```bash
pi install /path/to/pi-l1-cache
```

Then **restart pi** — the extension auto-loads.

## Configuration

### Environment Variables

```bash
# Enable/disable
L1_CACHE_ENABLED=true

# Max entries (default: 200)
L1_CACHE_MAX_ENTRIES=200

# Max memory in MB (default: 20)
L1_CACHE_MAX_MB=20

# TTL in seconds (default: 3600)
L1_CACHE_TTL=3600

# Log stats on each hit/miss (default: false)
L1_CACHE_LOG=true
```

### Settings (in `~/.pi/settings.json`)

```json
{
  "extensions": {
    "l1-cache": {
      "enabled": true,
      "maxEntries": 200,
      "maxMemoryBytes": 20971520,
      "ttlSeconds": 3600,
      "persist": true,
      "logStats": false
    }
  }
}
```

## Usage

### Show cache stats

```bash
/l1-cache
```

Output:
```
L1 cache: 16 entries, 43.2KB | hits 12 (replays 12), misses 4, writes 4, evictions 0 | dir: C:/Users/Tobias/.pi/agent/cache/l1-cache
```

### Clear cache

```bash
/l1-cache clear
```

Cleared: memory + disk (all `.json` files in cache dir).

## Key Semantics

The cache key is a stable hash of:
- `model`
- `messages` (full conversation history)
- `tools`
- `tool_choice`
- `temperature`, `top_p`
- `reasoning_effort`, `thinking`
- `max_completion_tokens`, `max_tokens`

**Volatile fields are EXCLUDED:** `prompt_cache_key`, `prompt_cache_retention`, `stream`, `stream_options`, `store`, `sessionId`.

This means:
- ✅ Cross-run hits possible (same prompt, same cwd, same model)
- ✅ Tool-calling agent loops fully replayed (tool results are part of messages)
- ❌ Different conversation history = different key (expected)
- ❌ Session-derived fields don't break cross-run hits

## Gotchas

1. **Replays are canned** — identical input returns the stored response verbatim. For fresh answers, use `/l1-cache clear`.

2. **Print mode** (`pi -p`) reads entire stdin as ONE prompt — you cannot test two identical requests in one process this way.

3. **llm-timestamp.js** does NOT pollute provider messages (it only appends display-level `message_end` entries), so keys are stable across runs.

4. **Replayed responses carry original responseId/usage** — accurate since input identical.

## Troubleshooting

### "fix-reasoning-content.js: layout changed"

The `fix-l1-cache.js` patch modifies the same file as `fix-reasoning-content.js`. The wrapper's postinstall chain handles this correctly — `fix-reasoning-content.js` now recognizes its work via marker even after the replay branch is added.

If you see this error:
1. Ensure you're running the full postinstall chain (not individual scripts)
2. Check that `fix-reasoning-content.js` has the marker-based detection (v1.2.3+)
3. Verify postinstall order: `fix-reasoning-content.js` BEFORE `fix-l1-cache.js`

### Cache never hits

Check:
1. `L1_CACHE_LOG=true` to see HIT/MISS/STORED logs
2. Prompt is byte-identical (including system prompt, tools, cwd context)
3. Disk persistence is enabled (`persist: true`)
4. TTL hasn't expired (default 1h)

## Development

### Testing

```bash
# Run unit tests
npm test

# Run the extension manually
npx tsx src/index.ts
```

### Benchmark

```bash
# Measure cold vs warm times
echo "What is 7*6?" | time pi -p "test"  # cold
echo "What is 7*6?" | time pi -p "test"  # warm (should be ~1.7× faster)
```

## License

MIT — see [LICENSE](LICENSE)

## Contact

- Issues: https://github.com/tobias-weiss-ai-xr/pi-l1-cache/issues
- Email: info@graphwiz.ai
