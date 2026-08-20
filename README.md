# pi-l1-cache

L1 in-memory cache extension for pi — CPU/RAM optimized.

## Features

- **~0.1ms lookup** — FNV-1a hash (100x faster than SHA256)
- **50MB hard cap** — prevents RAM bloat
- **CPU-aware** — auto-disables when CPU > 80%
- **LRU eviction** — automatic cleanup when at capacity
- **Stoic design** — 242 lines, one file, one purpose

## Install

```bash
# Global install
pi install git:github.com:tobias-weiss-ai-xr/pi-l1-cache@main

# Or local
pi install ./path/to/pi-l1-cache
```

## Usage

```bash
# Restart pi — extension auto-loads
pi

# In TUI
/l1-cache        # Show stats
/l1-cache stats  # Detailed stats
/l1-cache clear  # Reset cache
```

## Stats

```
L1: 47/500 | 4.2MB | Hits: 23 | Misses: 70 | Rate: 24.7% | CPU: OK
```

## Architecture

```
pi → [L1: RAM 50MB] → [L2: Redis via LiteLLM] → Provider
     <0.5ms          ~150ms                   1-3s
```

## Config

Edit `src/index.ts` defaults:

```typescript
const DEFAULTS: Settings = {
  enabled: true,
  maxEntries: 500,
  maxMemoryBytes: 50 * 1024 * 1024,  // 50MB
  ttlSeconds: 3600,                   // 1 hour
  cpuThreshold: 80,                   // skip if CPU > 80%
  logStats: true,
};
```

## License

MIT
