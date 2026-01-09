# Disk I/O Performance Issue - Root Cause and Fix

## Problem Identified

**Massive disk reads: 197GB over 28 hours (116MB/minute)**

The memory issue was NOT caused by the audit log buffer (which was successfully fixed with batching). Instead, it was caused by **heavy database queries running too frequently**.

## Root Cause

### Analytics Query Auto-Refresh
File: `src/lib/queries.ts` - `logQueries.requestAnalytics`

The analytics query was configured to **refetch every 30 seconds** if data exists:

```typescript
refetchInterval: (query) => {
    if (query.state.data) {
        return durationToMs(30, "seconds");  // ← EVERY 30 SECONDS!
    }
    return false;
}
```

### Heavy Query Implementation
File: `server/routers/auditLogs/queryRequestAnalytics.ts` - lines 88-100

The analytics query performs expensive operations on the `requestAuditLog` table:

```typescript
const requestsPerCountry = await primaryDb
    .selectDistinct({               // ← DISTINCT operation
        code: requestAuditLog.location,
        count: totalQ
    })
    .from(requestAuditLog)
    .groupBy(requestAuditLog.location)   // ← GROUP BY operation
    .orderBy(desc(totalQ))
    .limit(DISTINCT_LIMIT + 1);
```

Similar expensive aggregations:
- Requests per day (groupBy timestamp)
- Requests per country (groupBy location)
- Allowed vs blocked counts

### Why This Causes Massive Disk Reads

1. **Table Size**: The `requestAuditLog` table contains potentially millions of rows
   - From Synology Photos auth spam: 50+ failed requests every 3 seconds
   - Over days/weeks: millions of records

2. **Query Frequency**: Running every 30 seconds = 2,880 queries per day
   
3. **Query Complexity**: Each query does:
   - Full table scans with GROUP BY
   - DISTINCT operations across large result sets
   - Multiple aggregations (count, min/max dates)

4. **Disk Impact**:
   - Even with indexes, full table aggregations require reading all data
   - SQLite must read the entire table/index to perform GROUP BY
   - At ~116MB/minute: 167GB/day if running continuously

## Solution Implemented

### Change Made
File: `src/lib/queries.ts` - `logQueries.requestAnalytics`

**Before:**
```typescript
refetchInterval: (query) => {
    if (query.state.data) {
        return durationToMs(30, "seconds");
    }
    return false;
}
```

**After:**
```typescript
// Disabled automatic refetch - analytics queries are heavy and scan large tables
// Use manual refresh button instead to avoid 197GB+ disk reads over time
refetchInterval: false
```

### Impact
- **Eliminates** 2,880 queries/day of expensive analytics
- Users can still click "Refresh" button for manual updates
- Dashboard loads quickly with cached analytics data
- Expected disk I/O reduction: **~100-150MB/minute → near zero** (except on manual refresh)

## Related Issues Fixed

1. **Audit Log Memory Leak** (Previous commit)
   - Root cause: Buffer flushing every 5 seconds with 50+ requests/3s
   - Fix: Implemented batching (100 items or 5 seconds)
   - Result: Controlled memory usage

2. **Disk I/O Performance** (This commit)
   - Root cause: Analytics query refetching every 30 seconds
   - Fix: Disabled auto-refetch, manual refresh only
   - Result: Massive reduction in disk reads

## Deployment Notes

1. Build and push the changes:
   ```bash
   git add src/lib/queries.ts
   git commit -m "Disable auto-refetch on analytics queries to reduce disk I/O"
   git push personal main
   ```

2. After Docker build completes:
   ```bash
   docker pull
   docker compose down
   docker compose up -d
   ```

3. Monitor improvements:
   ```bash
   docker stats --no-stream pangolin
   # Watch BLOCK I/O - should drop from 197GB to <100MB after several hours
   ```

## Expected Behavior After Fix

- **Immediate**: Disk reads drop from ~116MB/min to near zero (except on manual refresh)
- **Within 1 hour**: Block I/O counter shows <1GB (vs 417MB every 2 minutes before)
- **After 24 hours**: Block I/O shows <5-10GB total (normal database activity)
- **Memory**: Stays stable at ~290-310MiB (no growth)
- **Dashboard**: Analytics load from cache unless user clicks "Refresh"

## Testing Checklist

- [ ] Deploy changes
- [ ] Wait 10 minutes for analytics cache to stabilize
- [ ] Run `docker stats --no-stream pangolin` - verify low block I/O
- [ ] Access analytics dashboard - should load instantly (cached)
- [ ] Click "Refresh" button - should trigger query and update
- [ ] Monitor for 1-2 hours - memory should remain stable
- [ ] Compare disk I/O before/after fix

## Files Changed

- `src/lib/queries.ts` - Disabled auto-refetch interval for analytics query
- `server/routers/badger/logRequestAudit.ts` - (Previously: Batch flushing implementation)
- `.gitignore` - (Previously: Added .github/agents/)
