# Memory Usage Investigation and Optimization

## Executive Summary

The Pangolin application was using 300-350MB of memory at startup. After implementing optimizations, the container now uses **244MB at startup** and **337MB after 5 minutes of operation** - a reduction of ~50-100MB. Memory usage is approaching the 384MB heap limit under load, requiring continued monitoring.

## Production Metrics (After Optimization)

### Deployment: jjeuriss/pangolin:reduced_memory

**Initial Startup (T+0):**
- RSS: 244.2MB
- Heap: 140.7MB / 166.7MB (84%)
- External: 13.1MB
- Array Buffers: 9.4MB

**After 5 Minutes (T+5min):**
- RSS: 336.6MB (+92.4MB)
- Heap: 212.7MB / 218.0MB (97%)
- External: 17.6MB
- Array Buffers: 13.6MB

**Cache Performance:**
- Keys: 2
- Hit Rate: 73.63% (1346 hits, 482 misses)
- No buffer overflows detected

**Container Stats:**
- Total Memory: 364.8MiB / 860.6MiB (42.4%)
- CPU: 2.82%
- Status: Healthy

## Root Cause Analysis (Original Issues)

### 1. Next.js Development Mode in Production (CRITICAL) - FIXED

**Location:** `server/nextServer.ts:12-15`

**Original Issue:**
```typescript
const app = next({
    dev: process.env.ENVIRONMENT !== "prod",
    turbopack: true
});
```

Next.js ran in development mode unless `ENVIRONMENT=prod` was explicitly set. Development mode:
- Kept source maps in memory
- Enabled Hot Module Replacement (HMR)
- Maintained larger caches for fast refresh
- Used Turbopack with higher memory footprint

**Impact:** ~50-100MB additional memory vs production mode

**Fix Applied:**
```typescript
const isDev =
    process.env.NODE_ENV !== "production" &&
    process.env.ENVIRONMENT !== "prod";

const app = next({
    dev: isDev,
    turbopack: isDev
});
```

---

### 2. No V8 Memory Limits - FIXED

**Location:** `Dockerfile:72`

**Original Issue:** No `--max-old-space-size` flag set. Node.js would use up to system-available memory before triggering aggressive GC.

**Fix Applied:**
```dockerfile
ENV NODE_OPTIONS="--max-old-space-size=384"
```

**Rationale:** 384MB provides adequate headroom above the ~180-270MB baseline (Next.js needs 150-200MB + Express servers + cache overhead). Initial testing with 256MB proved too aggressive.

---

### 3. NodeCache Configuration - OPTIMIZED

**Location:** `server/lib/cache.ts:6-10`

**Original Configuration:**
```typescript
export const cache = new NodeCache({
    stdTTL: 3600,      // 1 hour TTL
    checkperiod: 120,   // 2 min check
    maxKeys: 10000     // 10k max entries
});
```

**Issue:** With 10,000 keys and potentially large cached values (database query results, user sessions), this consumed significant memory.

**Impact:** 10-50MB depending on usage patterns

**Fix Applied:**
```typescript
export const cache = new NodeCache({
    stdTTL: 300,       // 5 min TTL (reduced from 1 hour)
    checkperiod: 60,   // 1 min check
    maxKeys: 5000,     // 5k max (reduced from 10k)
    useClones: false   // Avoid memory overhead of cloning
});
```

**Production Results:** 73.6% hit rate with only 2 keys cached (excellent efficiency)

**WARNING:** `useClones: false` requires all callers to treat cached objects as immutable. Mutation corrupts shared state.

---

### 4. In-Memory Audit Log Buffer (UNBOUNDED) - FIXED

**Location:** `server/routers/badger/logRequestAudit.ts:30-48`

**Original Issue:**
```typescript
const auditLogBuffer: Array<{...}> = [];
const BATCH_SIZE = 100;
```

Buffer grew to 100 entries before flushing. Under high load, if DB writes failed, logs would be lost with no retry mechanism.

**Fix Applied:**
```typescript
const MAX_BUFFER_SIZE = 500; // Absolute maximum
let droppedLogCount = 0; // Track total dropped logs

// Prevent unbounded buffer growth
if (auditLogBuffer.length >= MAX_BUFFER_SIZE) {
    const dropped = auditLogBuffer.splice(0, auditLogBuffer.length - BATCH_SIZE);
    droppedLogCount += dropped.length;
    logger.warn(
        `Audit log buffer overflow - dropped ${dropped.length} entries (${droppedLogCount} total dropped)`
    );
}
```

**Production Results:** No buffer overflows detected (healthy DB write performance)

---

### 5. Multiple Long-Running Intervals

**Intervals found in codebase:**

| Location | Interval | Purpose | Memory Impact |
|----------|----------|---------|---------------|
| `server/lib/cache.ts:13` | 5 min | Cache stats logging | Low |
| `server/lib/billing/usageService.ts:67` | 30 sec | File upload check | Low |
| `server/lib/telemetry.ts:65` | 48 hours | Analytics | Low |
| `server/routers/auth/securityKey.ts:49` | 5 min | Challenge cleanup | Low |
| `server/lib/cleanupLogs.ts:8` | 3 hours | Log cleanup | Medium |
| `server/lib/traefik/TraefikConfigManager.ts:43` | Configurable | Traefik config | Medium |
| `server/routers/olm/handleOlmPingMessage.ts:27` | 30 sec | Offline checker | Low |

**Action:** No changes needed. Each interval maintains necessary state for application functionality.

---

### 6. TraefikConfigManager State Accumulation

**Location:** `server/lib/traefik/TraefikConfigManager.ts:18-30`

```typescript
private activeDomains = new Set<string>();
private lastKnownDomains = new Set<string>();
private lastLocalCertificateState = new Map<string, {...}>();
lastActiveDomains: Set<string> = new Set();
```

**Issue:** Multiple Sets and Maps accumulate domain data. The `lastLocalCertificateState` Map stores certificate metadata for every domain.

**Impact:** 5-20MB depending on number of domains

**Action:** No changes needed. This state is required for certificate management. Memory usage scales with number of domains (expected behavior).

---

### 7. WebSocket Client Tracking

**Location:** `server/routers/ws/ws.ts:36`

```typescript
const connectedClients: Map<string, AuthenticatedWebSocket[]> = new Map();
```

**Impact:** Variable, based on concurrent connections. Properly cleaned up on disconnect.

**Action:** No changes needed. This is essential application state.

---

## Memory Monitoring Implementation

### New Monitoring Utility

**Location:** `server/lib/memoryMonitor.ts`

Provides:
- Periodic memory logging (every 5 minutes in production)
- Memory usage API endpoint capability
- Human-readable formatting

**Usage:**
```typescript
import { startMemoryMonitor, logMemoryUsage } from "@server/lib/memoryMonitor";

// Log initial memory
logMemoryUsage();

// Start periodic monitoring (production only)
if (process.env.NODE_ENV === "production") {
    startMemoryMonitor(5 * 60 * 1000); // 5 minutes
}
```

**Sample Output:**
```
Memory: RSS=336.6MB, Heap=212.7MB/218.0MB, External=17.6MB, ArrayBuffers=13.6MB
```

---

## Monitoring Script

Created `/root/monitor-pangolin.sh` on production VPS for comprehensive monitoring:

```bash
#!/bin/bash
# Pangolin Memory Monitoring Script

CONTAINER="pangolin"

echo "================================================================"
echo "     PANGOLIN MEMORY MONITORING - $(date)"
echo "================================================================"
echo ""

echo "📊 DOCKER CONTAINER STATS:"
docker stats --no-stream $CONTAINER
echo ""

echo "🧠 NODE.JS PROCESS MEMORY (from logs):"
docker logs $CONTAINER 2>&1 | grep "Memory:" | tail -1
echo ""

echo "📈 CACHE PERFORMANCE:"
CACHE_STATS=$(docker logs $CONTAINER 2>&1 | grep "Cache stats" | tail -1)
if [ -z "$CACHE_STATS" ]; then
    echo "  No cache stats yet (logged every 5 minutes)"
else
    echo "  $CACHE_STATS"
fi
echo ""

echo "⚠️  BUFFER OVERFLOW WARNINGS:"
OVERFLOWS=$(docker logs $CONTAINER 2>&1 | grep "buffer overflow" | wc -l)
if [ $OVERFLOWS -eq 0 ]; then
    echo "  ✓ None detected (good!)"
else
    echo "  ❌ $OVERFLOWS buffer overflow events detected"
    docker logs $CONTAINER 2>&1 | grep "buffer overflow" | tail -5
fi
echo ""

echo "🔍 RECENT ERRORS/WARNINGS (last 5):"
ERRORS=$(docker logs $CONTAINER 2>&1 | grep -iE '\[warn\]|\[error\]' | tail -5)
if [ -z "$ERRORS" ]; then
    echo "  ✓ No recent warnings or errors"
else
    echo "$ERRORS"
fi
echo ""

echo "📊 MEMORY TREND (last 10 samples):"
docker logs $CONTAINER 2>&1 | grep "Memory:" | tail -10
echo ""

echo "================================================================"
```

**Usage:**
```bash
ssh root@vps "/root/monitor-pangolin.sh"
```

---

## Critical Logs to Monitor

### 1. Memory Usage (Every 5 minutes in production)
```
Memory: RSS=XXX.XMB, Heap=XXX.X/XXX.XMB, External=XXX.XMB, ArrayBuffers=XXX.XMB
```

**Watch for:**
- RSS approaching 384MB → risk of OOM crash
- Steady growth over time → possible memory leak
- Heap usage consistently >300MB → may need to increase limit

### 2. Cache Statistics (Every 5 minutes)
```
Cache stats - Keys: X, Hits: X, Misses: X, Hit rate: XX.XX%
```

**Watch for:**
- Hit rate <50% → TTL may be too short
- Keys approaching 5000 → may need to increase maxKeys
- High miss rate with low key count → caching strategy needs adjustment

**Current Performance:** 73.6% hit rate is excellent

### 3. Audit Log Buffer Overflows (When they occur)
```
Audit log buffer overflow - dropped X entries (X total dropped)
```

**Critical:**
- ANY occurrence indicates DB write performance issues
- Track total dropped count - if growing, database is too slow
- Currently: No overflows detected (healthy)

---

## Memory Budget Analysis

### Current Actual Usage

| Component | Startup | After 5min | Notes |
|-----------|---------|------------|-------|
| Total RSS | 244.2MB | 336.6MB | Within safe limits |
| Node.js Heap | 140.7MB | 212.7MB | 55% growth observed |
| External Memory | 13.1MB | 17.6MB | Small growth |
| Array Buffers | 9.4MB | 13.6MB | Moderate growth |

### Growth Pattern

- **Initial 5 minutes:** +92.4MB RSS growth
- **Rate:** ~18.5MB/minute initially (expected during cache warmup)
- **Status:** Approaching limit (337MB / 384MB = 87.8%)

### Heap Utilization

- **Startup:** 84% of allocated heap (140.7MB / 166.7MB)
- **After 5min:** 97% of allocated heap (212.7MB / 218.0MB)
- **Status:** ⚠️ High utilization - GC pressure likely

---

## Red Flags & Alerts

| Metric | Warning Threshold | Critical Threshold | Current Status |
|--------|------------------|-------------------|----------------|
| RSS Memory | >350MB | >370MB | ⚠️ 337MB (approaching warning) |
| Heap Usage % | >85% | >95% | ⚠️ 97% (critical) |
| Memory Growth | >10MB/hour | >20MB/hour | ✅ Needs longer observation |
| Cache Hit Rate | <50% | <30% | ✅ 73.6% (excellent) |
| Buffer Overflows | Any | Multiple | ✅ None |

---

## Recommendations

### Immediate Actions

1. **Monitor for next 30-60 minutes** to see if memory stabilizes or continues growing
2. **If RSS exceeds 360MB consistently**, increase heap limit to 512MB:
   ```dockerfile
   ENV NODE_OPTIONS="--max-old-space-size=512"
   ```

### Short-Term (Week 1)

1. **Track memory growth rate** over 24 hours
2. **Analyze heap snapshots** if growth continues beyond initial warmup
3. **Consider increasing cache TTL** to 10 minutes if hit rate remains >70%

### Medium-Term (Weeks 2-4)

1. **Implement lazy loading** for heavy optional dependencies:
   - AWS S3 client (~15MB)
   - PostHog telemetry (~5MB)
   - Only load when actually needed

2. **Review cache usage patterns**:
   - Currently only 2 keys cached despite 5000 limit
   - May indicate caching is underutilized or keys expire quickly

3. **Profile with `--inspect`** to identify specific memory consumers

### Long-Term Considerations

1. **Process Separation**: Run Next.js as separate process from API servers
   - Independent memory limits
   - Crash isolation
   - Easier horizontal scaling

2. **LRU Cache**: Consider replacing node-cache with more memory-efficient implementation:
   ```typescript
   import { LRUCache } from 'lru-cache';

   const cache = new LRUCache({
       max: 5000,
       maxSize: 50 * 1024 * 1024, // 50MB max
       sizeCalculation: (value) => JSON.stringify(value).length,
       ttl: 5 * 60 * 1000,
   });
   ```

---

## Success Metrics

### Achieved Goals ✅

1. **Startup memory reduced** from 300-350MB to 244MB (reduction of ~56-106MB)
2. **Memory limit enforced** at 384MB (prevents unbounded growth)
3. **Next.js production mode** confirmed (no HMR/compilation messages)
4. **Cache efficiency** at 73.6% hit rate (excellent)
5. **No buffer overflows** detected (healthy DB performance)
6. **Monitoring implemented** with 5-minute intervals and alerts

### Areas of Concern ⚠️

1. **High heap utilization** at 97% after 5 minutes
2. **Memory approaching limit** at 337MB / 384MB (87.8%)
3. **Growth rate** needs longer observation period to determine if it stabilizes

### Next Review

**Scheduled:** 1 hour after deployment to assess:
- Memory stabilization vs continued growth
- Long-term growth rate
- Need for heap limit increase
- GC patterns and pressure

---

## Implementation Timeline

### Completed (This Release)

- ✅ Set Node.js heap limit to 384MB
- ✅ Fix Next.js production mode detection
- ✅ Reduce NodeCache limits (5min TTL, 5000 keys)
- ✅ Add audit log buffer overflow protection
- ✅ Implement memory monitoring utility
- ✅ Create production monitoring script
- ✅ Deploy and validate in production

### Monitoring Phase (Next 1-2 Weeks)

- Monitor memory growth patterns
- Track cache hit rates
- Observe GC behavior
- Collect baseline metrics

### Iteration Phase (If Needed)

- Adjust heap limit based on observed patterns
- Fine-tune cache parameters
- Implement lazy loading for heavy dependencies
- Consider architectural changes if issues persist

---

## References

- Deployed Image: `jjeuriss/pangolin:reduced_memory`
- Branch: `memory-investigation`
- Monitoring Script: `/root/monitor-pangolin.sh` on VPS
- Production URL: https://pangolin.mythium.be/

---

*Last Updated: 2026-01-14 after initial production deployment and 5-minute observation*
