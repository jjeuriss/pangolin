# Disk I/O Investigation - Findings Summary

**Status**: Investigation ongoing - root cause narrowed but not fully resolved
**Date**: 2026-01-13
**Last Updated**: 2026-01-13 20:30 UTC

---

## Executive Summary

The disk I/O spike is triggered by the **session verification query flow**, but the exact mechanism causing the 5-10 minute delayed spike remains unclear. Multiple fixes have been applied, reducing database query volume, but the core issue persists.

---

## Test Results Summary

| Test # | Configuration | Result | Conclusion |
|--------|---------------|--------|-----------|
| 1 | DISABLE_AUDIT_LOGGING=true | REPRODUCED | ❌ Not audit logging |
| 2 | DISABLE_GEOIP_LOOKUP + DISABLE_ASN_LOOKUP | REPRODUCED | ❌ Not geo/ASN lookups |
| 3 | Test 1 + Test 2 combined | REPRODUCED | ❌ Still not the issue |
| 4 | Test 3 + DISABLE_SESSION_QUERIES=true | **NOT REPRODUCED** | ✅ Session queries involved |
| 5 | DISABLE_RULES_CHECK=true | REPRODUCED | ❌ Not rules check |
| 6 | DISABLE_SESSION_QUERIES=true (alone) | **NOT REPRODUCED** | ✅ Confirmed |
| 7 | ALL flags disabled | NOT REPRODUCED | ✅ Confirms findings |
| 8 | getResourceAuthInfo caching added | REPRODUCED | ❌ Caching helped but not the cause |

---

## What We Know For Certain

### 1. Session Queries Are The Trigger
When `DISABLE_SESSION_QUERIES=true`:
- `getResourceByDomain()` returns `null` immediately
- Response is `{"valid":false}` with NO `redirectUrl`
- Client doesn't follow any redirects
- **No disk I/O spike, no memory buildup**

### 2. The Problem Is NOT:
- ❌ Audit logging (disabled, still reproduced)
- ❌ GeoIP/ASN lookups (disabled, still reproduced)
- ❌ Rules checking (disabled, still reproduced)
- ❌ `getResourceAuthInfo()` uncached queries (fixed, still reproduced)
- ❌ Memory leak (memory profiler shows normal GC pattern)

### 3. The Problem Characteristics:
- **Delayed onset**: Disk I/O spike happens 5-10 minutes after requests start
- **Memory pattern**: Heap grows and shrinks normally (GC working)
- **RSS usage**: ~360-390MB on 860MB VPS (45% of RAM)
- **Cache working**: `getResourceAuthInfo` shows mostly cache hits

---

## Request Flow Analysis

When session queries are **ENABLED** (problem reproduced):

```
1. Synology Photos requests thumbnail (50+ req/sec)
2. Badger intercepts → POST /api/v1/badger/verify-session
3. getResourceByDomain() → 5-table join (cached 5 sec)
4. Auth fails → Response with redirectUrl
5. Client follows redirect → GET /api/v1/resource/{guid}/auth
   └─ getResourceAuthInfo() → 4-table join (NOW cached 60 sec) ✅
6. Client calls → GET /api/v1/user
   └─ Unknown queries here (NOT investigated yet)
```

When session queries are **DISABLED** (problem NOT reproduced):

```
1. Synology Photos requests thumbnail
2. Badger intercepts → POST /api/v1/badger/verify-session
3. getResourceByDomain() → returns NULL immediately
4. Response: {"valid":false} with NO redirectUrl
5. Client gets simple denial, no follow-up requests
```

---

## Fixes Applied So Far

### Fix 1: getResourceAuthInfo Caching (Commit ede3ae40)
- **Added**: 60-second cache for `/api/v1/resource/{guid}/auth` endpoint
- **Result**: Cache hits working (confirmed in logs)
- **Impact**: Reduced database queries but disk I/O spike still occurs

### Fix 2: Memory Profiler (Commit 6362ef81)
- **Added**: 10-second interval memory logging
- **Result**: Shows normal GC pattern, not a memory leak
- **Impact**: Better visibility into memory behavior

### Fix 3: Feature Flags (Commit cbe315c2)
- **Added**: Multiple flags to disable features for testing
- **Result**: Enabled systematic testing
- **Impact**: Confirmed session queries as trigger

---

## Current Hypotheses

### Hypothesis A: SQLite WAL Checkpoint
- SQLite uses Write-Ahead Logging (WAL)
- Read queries still touch WAL file
- After accumulating activity, checkpoint flushes to main DB
- Could explain 5-10 minute delay before I/O spike

### Hypothesis B: OS Page Cache Pressure
- Node.js using ~390MB RSS
- VPS has 860MB total RAM
- OS needs page cache for SQLite file access
- Memory pressure causes cache eviction → disk I/O

### Hypothesis C: /api/v1/user Endpoint
- Called by client after auth failure
- Not yet investigated
- Could be doing expensive queries or accumulating data

### Hypothesis D: Request Volume Overwhelm
- When session queries enabled, requests take longer
- More concurrent connections pile up
- System resources exhausted over time

---

## Memory Profiler Sample Output

```
[MEMORY_PROFILER] Heap: 200/228MB | RSS: 302MB | Cache: 5 keys | Requests: 10.4/sec | Heap growth: 0MB/min
[MEMORY_PROFILER] Heap: 243/289MB | RSS: 367MB | Cache: 5 keys | Requests: 5.9/sec | Heap growth: +86MB/min
[MEMORY_PROFILER] Heap: 200/271MB | RSS: 303MB | Cache: 5 keys | Requests: 0.8/sec | Heap growth: -76MB/min
```

Pattern: Heap grows during request bursts, GC cleans it up → Normal behavior, not a leak.

---

## Next Steps To Try

### 1. Investigate /api/v1/user Endpoint
- What queries does it run?
- Is there caching?
- Add logging/caching if needed

### 2. Monitor SQLite WAL File
```bash
docker exec pangolin ls -la /app/db/
# Look for db.sqlite-wal file size
```

### 3. Increase Resource Cache TTL
In `server/routers/badger/verifySession.ts` line 221:
```typescript
// Change from 5 seconds to 60+ seconds
cache.set(resourceCacheKey, resourceData, 60);
```

### 4. Test with Memory Limit Increased
```yaml
# docker-compose.yml
mem_limit: 600M  # Instead of 400M
```

### 5. Profile SQLite Query Execution
Add query timing to understand actual database load.

---

## Files Modified During Investigation

| File | Change | Commit |
|------|--------|--------|
| `server/lib/featureFlags.ts` | Feature flag system | cbe315c2 |
| `server/db/queries/verifySessionQueries.ts` | DISABLE_SESSION_QUERIES flag | cbe315c2 |
| `server/routers/badger/logRequestAudit.ts` | DISABLE_AUDIT_LOGGING flag | cbe315c2 |
| `server/lib/geoip.ts` | DISABLE_GEOIP_LOOKUP flag | cbe315c2 |
| `server/lib/asn.ts` | DISABLE_ASN_LOOKUP flag | cbe315c2 |
| `server/routers/badger/verifySession.ts` | DISABLE_RULES_CHECK flag + memory profiler | various |
| `server/routers/resource/getResourceAuthInfo.ts` | Added 60-second caching | ede3ae40 |
| `server/lib/memoryProfiler.ts` | Memory profiling module | 6362ef81 |

---

## Key Insight

The fundamental issue is that when session queries are enabled:
1. Request finds the resource successfully
2. Full auth flow executes
3. Client receives redirect URL
4. Client makes additional requests
5. **Something accumulates over 5-10 minutes**
6. **Massive disk I/O spike occurs**

When session queries are disabled, the request fails fast at step 1 with "resource not found", preventing all subsequent processing.

---

## Environment Details

- **Platform**: Docker on VPS
- **RAM**: 860MB total, container limited to 400MB
- **Database**: SQLite (better-sqlite3)
- **Node.js**: Synchronous SQLite queries
- **Test Client**: Synology Photos app making 50+ thumbnail requests/sec

---

## Questions Still Open

1. What exactly accumulates during the 5-10 minute window?
2. Is SQLite WAL checkpointing the trigger for the I/O spike?
3. Does the /api/v1/user endpoint contribute to the problem?
4. Would increasing the container memory limit help?
5. Is there something specific about the request/response lifecycle that holds resources?

---
