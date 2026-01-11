# Disk I/O Investigation - v1.13.0/1.14.0/1.14.1

## Problem Statement
- **Symptoms**: 14.9GB disk I/O in 7 minutes on v1.13.0
- **Trigger**: Synology Photos app making ~50+ unauthenticated requests per 3 seconds
- **Impact**: OOM crashes, memory exhaustion, VPS instability
- **Issue**: Excessive READ I/O - much more than expected for simple authentication checks

---

## Attempted Fixes (All Failed)

### 1. Cache Stampede on getRetentionDays() - COMMIT 97645964
**Hypothesis**: Multiple concurrent unauthenticated requests causing cache misses on retention check, triggering thundering herd of duplicate DB queries (35/sec)

**Implementation**:
- Added `inflightRetentionChecks` Set to deduplicate in-flight retention queries
- Increased cache TTL from 300s to 3600s
- Added comprehensive DISK_IO_DEBUG monitoring

**Result**: ❌ **FAILED**
- Retention queries reduced from 35/sec to 0/sec ✓
- Disk I/O still 22.7GB ✗
- Conclusion: Not the root cause

---

### 2. Unbounded Audit Log Buffer for Unauthenticated Requests - COMMIT feb8fbb8
**Hypothesis**: Unauthenticated requests without orgId were being buffered indefinitely but never flushed to DB (no org context), causing unbounded buffer growth and OOM

**Implementation**:
- Added early return in `logRequestAudit()` to skip logging if `!data.orgId`
- Prevents buffering of orgId-less requests entirely

**Result**: ❌ **FAILED** (though fix was correct for OOM issue)
- Prevented OOM crashes ✓
- Audit buffer stayed at 0 items ✓
- Disk I/O still 2.36GB ✗
- Conclusion: Not the root cause (though legitimate fix for memory exhaustion)

---

### 3. Missing Database Index on resources.fullDomain - COMMIT bb8d8292 + 2ccc92a1
**Hypothesis**: `getResourceByDomain()` query filters by fullDomain but has no index, causing O(n) full table scans on every cache miss. With 200 requests and cache misses, this could cause massive disk I/O.

**Implementation**:
- Added `idx_resources_fullDomain` index to both SQLite and PostgreSQL schemas
- Created v1.14.1 migration scripts to create index on startup
- Deployed to VPS

**Result**: ❌ **INCONCLUSIVE / POSSIBLY FAILED**
- Migration ran successfully on VPS ✓
- Test results unclear - growth measurements similar before/after
  - Unfixed test: 364kB → 523kB (159kB growth)
  - Fixed test: 322kB → 489kB (167kB growth)
- User reported still seeing 2.36GB+ disk I/O in docker stats ✗
- Conclusion: Index may not have actually solved the problem

---

## Test Data Collected

### Unfixed Version (v1.14.0 without fixes)
```
Baseline READ I/O: 364kB
After 200 unauthenticated requests: 523kB
Growth: 159kB
User observation: 2.36GB total READ I/O reported
```

### Fixed Version (v1.14.1 with index)
```
Baseline READ I/O: 322kB
After 200 unauthenticated requests: 489kB
Growth: 167kB
```

**Issue**: Test shows minimal growth, but user reports 2.36GB still being used. Test methodology may not be capturing the actual problem.

---

## Key Findings

### What We Know:
1. **Unauthenticated requests only** - Authenticated requests don't cause the issue
2. **Volume dependent** - Problem only appears with high volume of unauthenticated requests
3. **Memory + Disk I/O** - Both memory and disk I/O spike together
4. **OOM crashes** - VPS had to be rebooted due to memory exhaustion
5. **Database access** - Requests do go through verify-session endpoint and trigger database queries

### Database Queries Triggered by Unauthenticated Requests:
1. `getResourceByDomain()` - Looks up resource by domain (cached for 5s)
2. `getResourceRules()` - If rules are enabled (cached for 5s)
3. `getUserSessionWithUser()` - If user session present (cached for 5s)
4. `verifyResourceAccessToken()` - If access token present
5. `getOrgLoginPage()` - If access denied and tier is STANDARD

### What's NOT the Issue:
- ❌ Cache stampede on retention queries (fixed but didn't help)
- ❌ Unbounded audit log buffer (fixed but didn't help)
- ❌ Filter attribute caching (investigated, not related)
- ❌ Analytics queries (checked, disabled in testing)
- ❌ Audit logging (disabled in one test attempt)

---

## Files Modified (v1.14.0 → v1.14.1)

### Schema Changes:
- `server/db/sqlite/schema/schema.ts` - Added index definition
- `server/db/pg/schema/schema.ts` - Added index definition

### Migration Files Created:
- `server/setup/scriptsSqlite/1.14.1.ts` - SQLite migration
- `server/setup/scriptsPg/1.14.1.ts` - PostgreSQL migration
- `server/setup/migrationsSqlite.ts` - Registered 1.14.1 migration
- `server/setup/migrationsPg.ts` - Registered 1.14.1 migration

### Version:
- `server/lib/consts.ts` - Bumped to 1.14.1

### Previous Fixes (Still in Place):
- `server/routers/badger/logRequestAudit.ts` - Cache stampede fix + audit log skip
- `server/setup/scriptsSqlite/1.14.0.ts` - v1.14.0 migrations (maintenance mode features)

---

## Docker Build Information
- **Latest build**: `2ccc92a1` (v1.14.1 with index migration)
- **Status**: Successfully built and deployed to VPS
- **Migration**: Confirmed executed on container startup
- **Tag**: `jjeuriss/pangolin:fixed`

---

## Next Steps for New Session

1. **Investigate Test Methodology**
   - Current test might not be measuring cumulative I/O correctly
   - `docker stats --no-stream` may reset between measurements
   - Need to verify how READ I/O accumulates over time

2. **Profile Under Real Load**
   - Run sustained traffic (not just 200 one-time requests)
   - Monitor I/O rate over extended period
   - Check if I/O is linear or exponential with request volume

3. **Check What Query is Actually Heavy**
   - Add detailed query logging/tracing
   - Measure time per query
   - Identify which specific database operation is slow
   - May need to profile at SQL level

4. **Verify Cache Behavior**
   - Check if cache is actually working
   - Verify cache hits/misses during test
   - Ensure resources aren't being re-queried constantly

5. **Consider Alternative Root Causes**
   - SQLite-specific limitations (may need better config)
   - Connection pooling issues
   - Query plan optimization
   - Lock contention
   - Disk subsystem limitations on VPS hardware

---

## Important Context

- User can connect to VPS at: `ssh root@vps -i ~/.ssh/id_strato`
- Docker container: `docker exec pangolin [command]`
- Database: SQLite at `/data/pangolin.db`
- Current version deployed: v1.14.1 with index fix
- Commits since start of investigation:
  - `97645964` - Cache stampede fix
  - `feb8fbb8` - Audit log skip for unauthenticated requests
  - `bb8d8292` - Database index (schema only)
  - `2ccc92a1` - Database index (migration files + version bump)

