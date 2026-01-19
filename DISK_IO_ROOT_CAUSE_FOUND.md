# Disk I/O Investigation - ONGOING

**Status**: ⚠️ PROBLEM STILL PERSISTS - Investigating with comprehensive logging
**Date**: 2026-01-13
**Last Updated**: 2026-01-19 20:05 UTC
**Current Strategy**: Added DEBUG logging to identify exact operation causing I/O spikes

---

## Executive Summary

**ISSUE**: High disk I/O and memory usage during unauthenticated request bursts (regression since v1.13.0).

**SYMPTOMS**:
- VPS becomes unresponsive after 5-10 minutes of high-volume unauthenticated requests (50+ req/sec)
- Disk read I/O spikes to 100% utilization
- Memory usage climbs steadily until system thrashes
- Problem is 100% reproducible with Synology Photos making thumbnail requests

**PREVIOUS THEORY (DISPROVEN)**: Infinite redirect loop causing exponential URL growth.
- Fixed in commit 99cdbed2 by preventing `/auth/resource/` pages from redirecting to themselves
- **Result**: Problem still persists after fix, so redirect loop was not the root cause

**NEW STRATEGY**: Comprehensive DEBUG logging added (commit 6754a9f1) to identify exact operation causing I/O spikes.

**PRIME SUSPECTS** (based on v1.12.3 → v1.13.0 code analysis):
1. 🔴 **Audit log batching system** - High-volume requests trigger frequent batch inserts (every 2-5 seconds)
2. 🟡 **Log cleanup bug fix** - More cleanup operations now run correctly, could cause large DELETE operations
3. 🟢 **Retention query cache stampede** - Multiple concurrent retention checks during high load

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

## 🎯 THE SMOKING GUN - Redirect Loop Discovery

**Date**: 2026-01-14 07:18 UTC
**Evidence**: Server logs just before VPS lockup

### The Log Entry That Revealed Everything

```
originalRequestURL: "https://photo.mythium.be/auth/resource/f3e01061...?redirect=https%3A%2F%2F...?redirect=https%253A%252F%252F...?redirect=..."
```

The URL contained **50+ nested redirect parameters**, each one URL-encoded multiple times. The full URL was over **100KB in size** from a single log entry!

### How The Loop Works

1. **Request 1**: Synology Photos requests `https://photo.mythium.be/thumbnail.jpg`
2. **Response 1**: `{valid: false, redirectUrl: "https://photo.mythium.be/auth/resource/GUID?redirect=https://photo.mythium.be/thumbnail.jpg"}`
3. **Request 2**: Client follows redirect to auth page
4. **Response 2**: Auth page ALSO gets intercepted by badger → `{valid: false, redirectUrl: "https://photo.mythium.be/auth/resource/GUID?redirect=https://photo.mythium.be/auth/resource/GUID?redirect=https://photo.mythium.be/thumbnail.jpg"}`
5. **Request 3-N**: Loop continues, URLs grow exponentially with each iteration
6. **After 5-10 minutes**: URLs are megabytes in size, memory exhausted, VPS hangs

### The Vulnerable Code

`server/routers/badger/verifySession.ts` line 348:

```typescript
const redirectPath = `/auth/resource/${encodeURIComponent(
    resource.resourceGuid
)}?redirect=${encodeURIComponent(originalRequestURL)}`;
```

This code **always** creates a redirect with the original URL, even when the original URL is ALREADY an auth page redirect. No loop detection.

---

## What We Know For Certain

### 1. Session Queries Are The Trigger
When `DISABLE_SESSION_QUERIES=true`:
- `getResourceByDomain()` returns `null` immediately
- Response is `{"valid":false}` with NO `redirectUrl`
- Client doesn't follow any redirects
- **No disk I/O spike, no memory buildup**

### 2. The Actual Root Cause: Redirect Loop
- ✅ **Redirect loop**: Auth page redirects to itself with nested parameters
- ✅ **Exponential URL growth**: URLs double in size with each iteration
- ✅ **Memory exhaustion**: Processing megabyte-sized URLs eventually exhausts memory
- ✅ **Explains 5-10 min delay**: Takes time for URLs to grow large enough to cause problems
- ✅ **Explains GC pattern**: Memory is cleaned, but new massive requests keep coming

### 3. Why Session Queries Flag Prevented It:
- When `DISABLE_SESSION_QUERIES=true`, `getResourceByDomain()` returns `null`
- Response becomes `{valid: false}` with **NO redirectUrl** field
- Client gets simple denial without redirect, preventing the loop
- No follow-up requests, no URL growth, no memory exhaustion

### 4. The Problem Is NOT:
- ❌ Audit logging (disabled, still reproduced)
- ❌ GeoIP/ASN lookups (disabled, still reproduced)
- ❌ Rules checking (disabled, still reproduced)
- ❌ `getResourceAuthInfo()` uncached queries (fixed, still reproduced)
- ❌ Memory leak (memory profiler shows normal GC pattern)
- ❌ SQLite WAL checkpoint
- ❌ Database query volume

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

### Fix 4: Increase Resource Cache TTL (Commit 96587485)
- **Changed**: `getResourceByDomain()` cache TTL from 5 seconds to 60 seconds
- **Location**: `server/routers/badger/verifySession.ts` line 225
- **Result**: Reduces database queries from every 5 seconds to every 60 seconds per domain
- **Impact**: Reduces SQLite load but does not fix redirect loop

### Fix 5: 🎯 **CRITICAL FIX** - Prevent Redirect Loop (Commit 99cdbed2)
- **Changed**: Detect when request path is already `/auth/resource/` and prevent recursive redirect
- **Location**: `server/routers/badger/verifySession.ts` line 351-356
- **Logic**:
  ```typescript
  const isAlreadyAuthPage = path.startsWith('/auth/resource/');
  const redirectPath = isAlreadyAuthPage ? undefined : '...';
  ```
- **Result**: Breaks the redirect loop, prevents exponential URL growth
- **Impact**: ✅ **SHOULD COMPLETELY FIX THE ISSUE**

---

## 🔍 NEW STRATEGY: Comprehensive DEBUG Logging (Commit 6754a9f1)

**Date**: 2026-01-19
**Status**: ⚠️ PROBLEM STILL PERSISTS - Redirect loop fix did not resolve the issue
**New Approach**: Add granular logging to identify the exact operation causing I/O spikes

### Why More Logging?

Despite fixing the redirect loop and increasing cache TTLs, the disk I/O problem continues to occur during high-volume unauthenticated request testing. The issue must be caused by:
1. A scheduled background task that triggers during the 5-10 minute window
2. Database operations accumulating and causing batch operations
3. A code path introduced in v1.13.0 that we haven't identified yet

### Code Analysis: v1.12.3 → v1.13.0 Changes

Critical changes that could explain the regression:

#### 🔴 **SUSPECT #1: Audit Log Batching System (HIGH PROBABILITY)**
In v1.13.0, audit logging was completely rewritten from immediate writes to a batching system:

**Old behavior (v1.12.3)**:
```typescript
// Each request wrote directly to database
await db.insert(requestAuditLog).values({...});
```

**New behavior (v1.13.0)**:
```typescript
// Logs buffer in memory (100 logs or 5 seconds)
auditLogBuffer.push({...});
if (auditLogBuffer.length >= 100) {
    flushAuditLogs(); // Batch insert
}
scheduleFlush(); // Or flush after 5 seconds
```

**Why this is suspicious**:
- High-volume unauthenticated requests (50+ req/sec) fill the buffer rapidly
- Buffer flushes trigger batch INSERT operations every ~2 seconds
- Batch inserts of 100+ rows could cause I/O spikes
- Timing aligns with 5-second flush interval and 5-10 minute accumulation

#### 🟡 **SUSPECT #2: Log Cleanup Bug Fix (MEDIUM PROBABILITY)**
In v1.12.3, there was a bug where all cleanup functions used `settingsLogRetentionDaysRequest`:

```typescript
// v1.12.3 - BUG: all used wrong retention setting
cleanUpOldActionLogs(orgId, settingsLogRetentionDaysRequest);
cleanUpOldAccessLogs(orgId, settingsLogRetentionDaysRequest);
cleanUpOldRequestLogs(orgId, settingsLogRetentionDaysRequest);
```

In v1.13.0, this was fixed:

```typescript
// v1.13.0 - FIXED: each uses correct retention
cleanUpOldActionLogs(orgId, settingsLogRetentionDaysAction);
cleanUpOldAccessLogs(orgId, settingsLogRetentionDaysAccess);
cleanUpOldRequestLogs(orgId, settingsLogRetentionDaysRequest);
```

**Why this is suspicious**:
- More cleanup operations now run (one per log type instead of all using same setting)
- Cleanup interval is every 3 hours
- If the test happens to hit the 3-hour mark, large DELETE operations could cause I/O spike
- Special retention value 9001 added (year-based cleanup) could trigger massive deletes

#### 🟢 **SUSPECT #3: Retention Query Cache Stampede (LOW PROBABILITY)**
The batching system checks retention settings for each org, which could cause:
- Multiple concurrent checks for the same org (cache stampede)
- Frequent database queries during high request volume
- Already has mitigation (`inflightRetentionChecks`) but may not be sufficient

### Logging Strategy

Added comprehensive DEBUG logging with performance timing to all critical paths:

#### 1. Database Query Operations
**File**: `server/db/queries/verifySessionQueries.ts`
**Prefix**: `[DB_QUERY]`

Logs all 7 query functions called during unauthenticated requests:
```
[DB_QUERY] getResourceByDomain START - domain=photo.example.com
[DB_QUERY] getResourceByDomain END - domain=photo.example.com, duration=2.45ms, found=true
[DB_QUERY] getResourceRules START - resourceId=123
[DB_QUERY] getResourceRules END - resourceId=123, duration=1.23ms, rulesCount=5
[DB_QUERY] getUserSessionWithUser START - sessionId=abc123
[DB_QUERY] getUserSessionWithUser END - sessionId=abc123, duration=1.89ms, found=true
[DB_QUERY] getUserOrgRole START - userId=user1, orgId=org1
[DB_QUERY] getUserOrgRole END - userId=user1, orgId=org1, duration=1.12ms, found=true
[DB_QUERY] getRoleResourceAccess START - resourceId=123, roleId=456
[DB_QUERY] getRoleResourceAccess END - resourceId=123, roleId=456, duration=0.98ms, found=true
[DB_QUERY] getUserResourceAccess START - userId=user1, resourceId=123
[DB_QUERY] getUserResourceAccess END - userId=user1, resourceId=123, duration=0.87ms, found=false
[DB_QUERY] getOrgLoginPage START - orgId=org1
[DB_QUERY] getOrgLoginPage END - orgId=org1, duration=1.34ms, found=true
```

#### 2. Badger Request Verification Flow
**File**: `server/routers/badger/verifySession.ts`
**Prefix**: `[BADGER_VERIFY]`

Logs cache behavior and request flow:
```
[BADGER_VERIFY] REQUEST START - host=photo.example.com, path=/thumbnail.jpg, authenticated=false
[BADGER_VERIFY] CACHE MISS - resourceCacheKey=resource:photo.example.com, fetching from database
[BADGER_VERIFY] CACHE SET - resourceCacheKey=resource:photo.example.com, ttl=60s, resourceId=123
[BADGER_VERIFY] CACHE HIT - resourceCacheKey=resource:photo.example.com, resourceId=123
```

#### 3. Rules Checking
**File**: `server/routers/badger/verifySession.ts`
**Prefix**: `[CHECK_RULES]`

Logs rule evaluation with cache behavior:
```
[CHECK_RULES] START - resourceId=123, clientIp=192.168.1.1, path=/thumbnail.jpg
[CHECK_RULES] CACHE MISS - fetching rules from database, resourceId=123
[CHECK_RULES] CACHE SET - ruleCacheKey=rules:123, ttl=5s, rulesCount=5
[CHECK_RULES] CACHE HIT - ruleCacheKey=rules:123, rulesCount=5
```

#### 4. Audit Log Batch Flushing
**File**: `server/routers/badger/logRequestAudit.ts`
**Prefix**: `[AUDIT_LOG_FLUSH]`

Logs batch insert operations with timing:
```
[AUDIT_LOG_FLUSH] START - flushing 100 logs to database, retryCount=0
[AUDIT_LOG_FLUSH] SUCCESS - flushed 100 logs, insertDuration=45.23ms, totalDuration=47.89ms
[AUDIT_LOG_FLUSH] ERROR - failed to flush 100 logs after 523.45ms: [error details]
```

#### 5. Log Cleanup Operations
**File**: `server/lib/cleanupLogs.ts`
**Prefix**: `[LOG_CLEANUP]`

Logs scheduled cleanup (every 3 hours):
```
[LOG_CLEANUP] ===== LOG CLEANUP STARTED =====
[LOG_CLEANUP] Querying orgs with retention policies
[LOG_CLEANUP] Found 3 orgs to clean, query took 5.67ms
[LOG_CLEANUP] Cleaning logs for orgId=org1, retentionDays: action=30, access=30, request=7
[LOG_CLEANUP] Cleaning action logs for orgId=org1, retentionDays=30
[LOG_CLEANUP] Cleaned action logs for orgId=org1, took 234.56ms
[LOG_CLEANUP] Cleaning access logs for orgId=org1, retentionDays=30
[LOG_CLEANUP] Cleaned access logs for orgId=org1, took 189.23ms
[LOG_CLEANUP] Cleaning request logs for orgId=org1, retentionDays=7
[LOG_CLEANUP] Cleaned request logs for orgId=org1, took 567.89ms
[LOG_CLEANUP] ===== LOG CLEANUP COMPLETED ===== Total duration: 1234.56ms
```

#### 6. Request Audit Cleanup
**File**: `server/routers/badger/logRequestAudit.ts`
**Prefix**: `[REQUEST_AUDIT_CLEANUP]`

Logs delete operations with row counts:
```
[REQUEST_AUDIT_CLEANUP] START - orgId=org1, retentionDays=7, cutoffTimestamp=1234567890
[REQUEST_AUDIT_CLEANUP] COMPLETED - orgId=org1, duration=567.89ms, deletedRows=15234
[REQUEST_AUDIT_CLEANUP] ERROR - orgId=org1, duration=823.45ms, error: [details]
```

### How to Use the Logs

When reproducing the issue with unauthenticated request bursts:

#### 1. Filter for All Debug Logs
```bash
docker logs pangolin 2>&1 | grep -E "\[DB_QUERY\]|\[BADGER_VERIFY\]|\[AUDIT_LOG_FLUSH\]|\[LOG_CLEANUP\]|\[REQUEST_AUDIT_CLEANUP\]|\[CHECK_RULES\]"
```

#### 2. Look for These Patterns During I/O Spike

**Pattern A: Frequent Audit Flushes**
```bash
# Should see flushes every ~5 seconds or every 100 requests
docker logs pangolin 2>&1 | grep "\[AUDIT_LOG_FLUSH\]" | tail -50
```
- **RED FLAG**: Flush duration >100ms consistently
- **RED FLAG**: Many ERROR entries indicating failed flushes
- **RED FLAG**: Flush frequency <2 seconds (buffer filling too fast)

**Pattern B: Cleanup Operations**
```bash
# Check if cleanup happens during test window (every 3 hours)
docker logs pangolin 2>&1 | grep "\[LOG_CLEANUP\]"
```
- **RED FLAG**: Cleanup starts around the time of I/O spike
- **RED FLAG**: Individual cleanup operations taking >1 second
- **RED FLAG**: Large number of deleted rows (>10,000)

**Pattern C: Cache Behavior**
```bash
# Should see mostly cache hits after initial requests
docker logs pangolin 2>&1 | grep "CACHE" | tail -100
```
- **RED FLAG**: Excessive CACHE MISS entries (cache not working)
- **RED FLAG**: Cache keys expiring too quickly

**Pattern D: Slow Database Queries**
```bash
# All queries should be <10ms with proper indexing
docker logs pangolin 2>&1 | grep "\[DB_QUERY\]" | grep "duration="
```
- **RED FLAG**: Any query taking >50ms
- **RED FLAG**: getResourceByDomain taking >10ms (5-table join)

#### 3. Timeline Analysis

Create a timeline of what happens during the 5-10 minute window:

```bash
# Get all debug logs with timestamps
docker logs pangolin 2>&1 --timestamps | grep -E "\[DB_QUERY\]|\[BADGER_VERIFY\]|\[AUDIT_LOG_FLUSH\]|\[LOG_CLEANUP\]|\[REQUEST_AUDIT_CLEANUP\]|\[CHECK_RULES\]" > debug_timeline.log
```

Then analyze:
1. What operation is running when I/O spike begins?
2. Is it a scheduled task (LOG_CLEANUP)?
3. Is it accumulation of audit flushes?
4. Is it a specific query pattern?

### Expected Findings

Based on the code analysis, we expect to find:

**Most Likely**: `[AUDIT_LOG_FLUSH]` operations showing:
- Frequent flushes (every 2-5 seconds)
- Batch inserts of 100+ rows
- Duration increasing over time
- Potential correlation with I/O spike

**Also Likely**: `[LOG_CLEANUP]` operation showing:
- Cleanup starts during the 5-10 minute test window
- Large DELETE operations (>10,000 rows)
- Duration >1 second
- Direct correlation with I/O spike

**Less Likely**: Database query performance issues showing:
- Individual queries taking >50ms
- Cache misses where hits expected
- Query volume overwhelming SQLite

### Success Criteria

After reproduction with new logging, we should be able to:
1. ✅ Identify the exact timestamp when I/O spike begins
2. ✅ Identify the exact operation executing at that moment
3. ✅ Measure the duration and frequency of the problematic operation
4. ✅ Understand why it started in v1.13.0 and not v1.12.3
5. ✅ Implement a targeted fix for the root cause

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
| `server/db/queries/verifySessionQueries.ts` | DISABLE_SESSION_QUERIES flag + DB query logging | cbe315c2, 6754a9f1 |
| `server/routers/badger/logRequestAudit.ts` | DISABLE_AUDIT_LOGGING flag + batch flush logging | cbe315c2, 6754a9f1 |
| `server/lib/geoip.ts` | DISABLE_GEOIP_LOOKUP flag | cbe315c2 |
| `server/lib/asn.ts` | DISABLE_ASN_LOOKUP flag | cbe315c2 |
| `server/routers/badger/verifySession.ts` | DISABLE_RULES_CHECK flag + request flow logging | various, 6754a9f1 |
| `server/routers/resource/getResourceAuthInfo.ts` | Added 60-second caching | ede3ae40 |
| `server/lib/memoryProfiler.ts` | Memory profiling module | 6362ef81 |
| `server/lib/cleanupLogs.ts` | Added cleanup operation logging | 6754a9f1 |

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

## Commit History (For Reference)

Investigation commits in chronological order:

| Commit | Description |
|--------|-------------|
| `97645964` | Fix cache stampede on retention check queries |
| `feb8fbb8` | Skip audit logging for unauthenticated requests |
| `bb8d8292` | Add missing database index on resources.fullDomain |
| `2ccc92a1` | Database migration for fullDomain index |
| `cbe315c2` | **Add feature flags for disk I/O investigation** |
| `2a6f7866` | Add flag to disable org access policy checks |
| `145ee475` | Add detailed logging for feature flag verification |
| `6362ef81` | **Add memory profiler for leak investigation** |
| `ede3ae40` | **Add caching to getResourceAuthInfo (60-second TTL)** |
| `70140a78` | Update investigation findings document |
| `96587485` | **Increase resource cache TTL from 5s to 60s** |
| `99cdbed2` | ⚠️ **ATTEMPTED FIX: Prevent infinite redirect loop in auth flow** (Did not fix the issue) |
| `6754a9f1` | 🔍 **Add comprehensive DEBUG logging for root cause identification** |

**Key commits to reference:**
- `cbe315c2` - Feature flags: `DISABLE_SESSION_QUERIES`, `DISABLE_AUDIT_LOGGING`, etc.
- `6362ef81` - Memory profiler logs every 10 seconds
- `ede3ae40` - getResourceAuthInfo caching fix
- `99cdbed2` - ⚠️ **Redirect loop prevention (did not fix the issue)**
- `6754a9f1` - 🔍 **Comprehensive DEBUG logging to identify root cause**

---

## Suggested Next Steps

### ✅ Priority 1: Increase Resource Cache TTL (COMPLETED - Commit 96587485)
Changed `getResourceByDomain()` cache TTL from 5 seconds to 60 seconds in `server/routers/badger/verifySession.ts`.

### ⚠️ Priority 2: Fix Redirect Loop (COMPLETED BUT DID NOT FIX ISSUE - Commit 99cdbed2)
Added logic to detect when request path is already `/auth/resource/` and prevent recursive redirect creation.
**Result**: Problem still persists, redirect loop was not the root cause.

### ✅ Priority 3: Add Comprehensive Logging (COMPLETED - Commit 6754a9f1)
Added DEBUG logging throughout the application to identify the exact operation causing I/O spikes.

### 🔥 Priority 4: REPRODUCE WITH NEW LOGGING AND ANALYZE
Rebuild, redeploy, and run the Synology Photos load test with comprehensive logging enabled.

**During reproduction**:
1. Monitor logs in real-time: `docker logs -f pangolin 2>&1 | grep -E "\[DB_QUERY\]|\[AUDIT_LOG_FLUSH\]|\[LOG_CLEANUP\]"`
2. Capture full timeline: `docker logs pangolin 2>&1 --timestamps > full_log.txt`
3. Note exact timestamp when I/O spike begins
4. Filter logs around that timestamp to identify the operation

**Expected outcome**: Logs will reveal whether it's:
- Audit log batch flushes taking too long
- Log cleanup operations running during test window
- Database queries performing poorly
- Cache not working as expected

### Priority 5: Monitor Logs During Test
```bash
# Before test
docker exec pangolin ls -la /app/db/

# During test (watch for growth)
watch -n 5 'docker exec pangolin ls -la /app/db/'

# Look for db.sqlite-wal file size increasing
```

### Priority 4: Investigate /api/v1/user Endpoint
- Check what queries it runs
- Add caching if needed
- This endpoint is called after every auth failure redirect

### Priority 5: Test with Higher Memory Limit
```yaml
# docker-compose.yml
services:
  pangolin:
    mem_limit: 600M  # Up from 400M
```

---

## How to Use Feature Flags

Add to docker-compose.yml `environment` section:

```yaml
environment:
  # Disable features for testing (set to 'true' to disable)
  - DISABLE_SESSION_QUERIES=true      # Returns "resource not found" immediately
  - DISABLE_AUDIT_LOGGING=true        # Skips all audit log writes
  - DISABLE_GEOIP_LOOKUP=true         # Skips MaxMind country lookup
  - DISABLE_ASN_LOOKUP=true           # Skips MaxMind ASN lookup
  - DISABLE_RULES_CHECK=true          # Skips rule evaluation
  - DISABLE_ORG_ACCESS_POLICY=true    # Skips org policy checks
```

**Confirmed**: Only `DISABLE_SESSION_QUERIES=true` prevents the disk I/O issue.

---
