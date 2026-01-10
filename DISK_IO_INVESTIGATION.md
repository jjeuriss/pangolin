# Disk I/O Investigation - Pangolin 1.13.0 Regression

## Timeline of Investigation

### Initial Problem
- **Reported**: 13.6GB read I/O in 50 minutes on version 1.13.0
- **Baseline**: Version 1.12.3 had normal I/O levels
- **Symptom**: Synology Photos app unable to load photos due to authentication failure
- **Impact**: Even unauthenticated requests causing massive disk reads

### Fix Attempt #1: Analytics Auto-Refresh (DISK_IO_FIX.md)
**Hypothesis**: Analytics queries running every 30 seconds causing excessive I/O

**Implementation**: Disabled auto-refresh in `src/lib/queries.ts`
```typescript
refetchInterval: false  // Was: 30 seconds
```

**Result**: ❌ **FAILED** - Did not resolve the issue

---

### Fix Attempt #2: Filter Attributes Caching (DISK_IO_FIX_FILTER_ATTRIBUTES.md)
**Hypothesis**: `queryUniqueFilterAttributes()` running expensive DISTINCT queries on every audit logs page load

**Root Cause Analysis**:
- File: `server/routers/auditLogs/queryRequestAuditLog.ts`
- Function runs 5 DISTINCT queries in parallel on every page load
- Each DISTINCT requires full table scan of `requestAuditLog` table
- With millions of rows from failed auth spam, this causes massive I/O

**Implementation**:
- Added 15-minute caching to filter attributes queries
- Implemented time bucketing for better cache hit rate
- Added TypeScript type safety
- Added non-spammy cache monitoring (logs every 5 minutes)

**Files Changed**:
- `server/routers/auditLogs/queryRequestAuditLog.ts`
- `server/private/routers/auditLogs/queryAccessAuditLog.ts`
- `server/private/routers/auditLogs/queryActionAuditLog.ts`

**Cache Performance**:
```
Cache stats: 2 hits, 1 misses (66.7% hit rate) over 12 minutes
```

**Result**: ❌ **FAILED** - I/O actually got **WORSE**
- Before fix: 13.6GB in 50 minutes (~272 MB/min)
- After fix: **19.7GB in 10 minutes (~1.97 GB/min)**
- After fix: **22.5GB in ~15 minutes (~1.5 GB/min)**

**Conclusion**: Filter queries were NOT the main issue

---

### Current Test: Disable All Request Audit Logging
**Hypothesis**: Database **writes** (audit log inserts) are causing excessive **reads**

**Observation**:
- Database file: `/app/config/db/db.sqlite` (only 1MB)
- 22.5GB read I/O with 1MB database = **~22,500 full database reads**
- This is completely abnormal for SQLite

**Possible Causes**:
1. **SQLite WAL Checkpoint Issues**
   - WAL file not present (checked, no WAL file found)
   - But writes could trigger expensive checkpoint operations

2. **Index Maintenance During Inserts**
   - Each INSERT updates multiple indexes
   - Index updates might trigger full table reads for some reason

3. **Query Running in Loop**
   - Hidden background query polling the database
   - Telemetry/health checks reading excessively

4. **File System Issue**
   - Docker volume causing read amplification
   - Host file system issues

**Test Implementation**:
File: `server/routers/badger/logRequestAudit.ts`
```typescript
export async function logRequestAudit(...) {
    try {
        // TEMPORARILY DISABLED FOR DISK I/O TESTING
        logger.debug("[REQUEST_AUDIT] Logging temporarily disabled for disk I/O testing");
        return;
        // ... rest of function commented out with eslint-disable
    }
}
```

**Expected Outcome**:
- **If I/O drops significantly**: Issue is with audit log writes → investigate SQLite write behavior
- **If I/O persists**: Issue is elsewhere → look for hidden query loops

**Status**: ⏳ Build in progress, waiting for deployment

---

## Technical Details

### Database Information
- **Engine**: SQLite
- **File**: `/app/config/db/db.sqlite`
- **Size**: 1MB
- **WAL Mode**: Not enabled (no .sqlite-wal file present)

### Request Pattern from Synology Photos
- **Frequency**: ~50+ requests every 3 seconds
- **Type**: Thumbnail requests (GET /webapi/entry.cgi)
- **Authentication**: All failing (no valid session)
- **Result**: Every request triggers audit log write

### Read I/O Metrics
```
Container uptime: 15 minutes
Total read I/O: 22.5GB
Read rate: ~1.5 GB/min
Database size: 1MB
Reads per database: ~22,500 times
```

**This is abnormal** - a 1MB database should not cause 22.5GB of read I/O in 15 minutes.

---

## Next Steps

1. **Test with audit logging disabled** (in progress)
   - Deploy commit `e2b30723` (fixed build errors in `5ed4e429`)
   - Monitor disk I/O for 10-15 minutes
   - Compare before/after metrics

2. **If I/O drops**:
   - Investigate SQLite write performance
   - Consider optimizing audit log table structure
   - Look into WAL mode configuration
   - Check if indexes are causing issues

3. **If I/O persists**:
   - Enable query logging to see what's actually reading
   - Check for hidden background jobs
   - Investigate Docker volume performance
   - Look for memory-mapped file issues

---

## Files Modified in This Investigation

### Disk I/O Fix Attempts
1. `src/lib/queries.ts` - Disabled analytics auto-refresh
2. `server/routers/auditLogs/queryRequestAuditLog.ts` - Added filter caching + monitoring
3. `server/private/routers/auditLogs/queryAccessAuditLog.ts` - Added filter caching
4. `server/private/routers/auditLogs/queryActionAuditLog.ts` - Added filter caching
5. `server/routers/badger/logRequestAudit.ts` - Temporarily disabled for testing

### Documentation
1. `DISK_IO_FIX.md` - Analytics auto-refresh fix documentation
2. `DISK_IO_FIX_FILTER_ATTRIBUTES.md` - Filter caching fix documentation
3. `DISK_IO_INVESTIGATION.md` - This file

---

## Commits

1. `a750f18f` - Fix disk I/O regression: Add caching to audit log filter queries
2. `e2b30723` - TEST: Temporarily disable request audit logging to isolate disk I/O issue
3. `5ed4e429` - Fix build: Add eslint-disable for unreachable code in test version

---

## Questions Still Open

1. **Why is a 1MB database causing 22.5GB of read I/O?**
   - This suggests either:
     - Extremely inefficient query patterns
     - File system issue (read amplification)
     - Hidden query loop we haven't discovered

2. **Was this issue present in 1.12.3?**
   - Need to compare disk I/O metrics from 1.12.3 with same request load
   - User reports issue started in 1.13.0

3. **What changed in the database layer between 1.12.3 and 1.13.0?**
   - Need to review database schema changes
   - Check for new indexes added
   - Look for query pattern changes

---

## Useful Commands for Monitoring

```bash
# Check current disk I/O
ssh root@vps -i ~/.ssh/id_strato "docker stats --no-stream pangolin"

# Check cache effectiveness
ssh root@vps -i ~/.ssh/id_strato "docker logs pangolin 2>&1 | grep FILTER_ATTRS"

# Check audit log disabled message
ssh root@vps -i ~/.ssh/id_strato "docker logs pangolin 2>&1 | grep REQUEST_AUDIT"

# Count request attempts
ssh root@vps -i ~/.ssh/id_strato "docker logs pangolin 2>&1 | grep -c 'Verify session: Badger sent'"
```
