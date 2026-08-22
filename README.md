# pi-l1-cache

> **L1 In-Memory Cache Extension for pi** — CPU/RAM optimized, production-ready

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Pi Package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)

A high-performance, production-ready **L1 (in-memory) cache** extension for the [pi coding agent](https://pi.dev). Designed for stoic Unix simplicity: one file, one purpose, zero dependencies.

## Features

| Feature | Description |
|---------|-------------|
| **~0.1ms lookup** | FNV-1a fast hash — ~100× faster than SHA256 |
| **Memory cap** | Hard limit (20MB default) prevents RAM bloat |
| **Auto-eviction** | LRU-style cleanup when limits reached |
| **CPU-aware** | Auto-disables when CPU > 95% |
| **TTL-based** | 1-hour default expiry for cached entries |
| **Atomic cleanup** | Periodic expired entry removal |

## Architecture

```
pi → [L1: RAM Map] → [L2: Redis via LiteLLM] → Provider
     <0.5ms          ~150ms                   1-3s
```

## Installation

```bash
# From npm (recommended)
pi install npm:pi-l1-cache

# From GitHub
pi install git:github.com/tobias-weiss-ai-xr/pi-l1-cache@main

# From local clone
pi install /path/to/pi-l1-cache
```

Then **restart pi** — the extension auto-loads.

## Usage

```bash
# Show cache stats
/l1-cache

# Show detailed stats
/l1-cache stats

# Clear cache
/l1-cache clear

# Enable cache (if disabled)
/l1-cache enable

# Disable cache (if enabled)
/l1-cache disable
```

### Stats Output

```
L1 cache status: ENABLED
Entries: 47 / 200
Memory: 4.2MB / 20MB
TTL: 3600s | CPU threshold: 95%
Hits: 23 | Misses: 70 | Evictions: 5
Hit rate: 24.7%
Init CPU: 45.2% (ok)
Last cleanup: 2025-08-22T10:30:00.000Z
```

## Configuration

### Environment Variables

Change defaults without modifying source code:

| Variable | Default | Description |
|----------|---------|-------------|
| `L1_CACHE_ENABLED` | `true` | Master enable/disable |
| `L1_CACHE_MAX_ENTRIES` | `200` | Maximum number of cache entries |
| `L1_CACHE_MAX_MB` | `20` | Maximum memory in MB |
| `L1_CACHE_TTL` | `3600` | TTL in seconds (1 hour) |
| `L1_CACHE_LOG` | `false` | Enable debug logging |

Example:
```bash
# Disable cache
L1_CACHE_ENABLED=false pi

# Use 50MB cache with 30-minute TTL
L1_CACHE_MAX_MB=50 L1_CACHE_TTL=1800 pi
```

### Default Settings

Edit `src/index.ts` (lines 30-38) to change compiled-in defaults:

```typescript
const DEFAULTS: Settings = {
  enabled: true,
  maxEntries: 200,
  maxMemoryBytes: 20 * 1024 * 1024, // 20MB
  ttlSeconds: 3600,                // 1 hour
  cpuThreshold: 95,                 // disable if CPU > 95%
  logStats: false,
}
```

## Design Philosophy

### Stoic Unix Principles
- **One thing, done well** — Caching, and only caching
- **Do not rely on external services** — Pure in-memory, no Redis
- **Graceful degradation** — Works even on constrained systems
- **Zero dependencies** — Single TypeScript file

### Performance Optimizations
1. **Fast string hashing** (FNV-1a) instead of SHA256
2. **L1 only** — avoid disk I/O in hot path
3. **Batch eviction** — remove 10-20% at a time, not one-by-one
4. **Periodic cleanup** — async, non-blocking garbage collection
5. **Single CPU check** — at startup only, not per-request

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Check TypeScript
npx tsc --noEmit
```

17 tests covering:
- Hash consistency & collision resistance
- Size estimation for various data types
- LRU eviction behavior (entry count + memory)
- State management & reset
- Settings override

## Related Projects

- **[opencode-saia-plugin](https://github.com/tobias-weiss-ai-xr/opencode-saia-plugin)** — SAIA provider for OpenCode
- **[zot-saia-plugin](https://github.com/tobias-weiss-ai-xr/zot-saia-plugin)** — SAIA provider for zot CLI
- **[pi-saia-plugin](https://github.com/tobias-weiss-ai-xr/pi-saia-plugin)** — SAIA provider for pi coding agent

## License

MIT — see [LICENSE](LICENSE)

## Maintainer

[Tobias Weiß](https://github.com/tobias-weiss-ai-xr) — weissto@hrz.uni-marburg.de
