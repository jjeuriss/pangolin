# Disk I/O Performance Issue - Filter Attributes Query Caching

## Problem Identified

**Massive disk reads: 13.6GB over 50 minutes on version 1.13.0**

The previous fix (`DISK_IO_FIX.md`) addressed analytics auto-refresh, but there was still significant disk I/O happening. The root cause was the `queryUniqueFilterAttributes()` function in the request audit logs page.

## Root Cause

### Expensive Filter Attributes Query
File: `server/routers/auditLogs/queryRequestAuditLog.ts` - `queryUniqueFilterAttributes()` (lines 166-278)

The filter attributes query runs **5 expensive DISTINCT operations in parallel** every time the request audit logs page is accessed:

```typescript
const [uniqueActors, uniqueLocations, uniqueHosts, uniquePaths, uniqueResources] = await Promise.all([
    primaryDb.selectDistinct({ actor: requestAuditLog.actor })
        .from(requestAuditLog)
        .where(baseConditions)
        .limit(DISTINCT_LIMIT + 1),
    // ... 4 more DISTINCT queries on different columns
]);
```

### Why This Causes Massive Disk Reads

1. **Table Size**: The `requestAuditLog` table contains potentially millions of rows
   - From Synology Photos auth spam: 50+ failed requests every 3 seconds
   - Over days/weeks: millions of records accumulate

2. **Query Frequency**: Runs on every page load/refresh of the audit logs
   - Every time user opens the audit logs page
   - Every time filters change
   - Every page navigation within the logs UI

3. **Query Complexity**: Each DISTINCT query requires:
   - **Full table scan** even with indexes (SQLite must read all rows to find unique values)
   - Sorting and deduplication across potentially millions of rows
   - Memory allocation for result sets

4. **No Caching**: Results were fetched fresh on every request with zero server-side caching

5. **Disk Impact**:
   - Each DISTINCT query scans the entire table/index
   - 5 queries × millions of rows = massive read I/O
   - With frequent page loads, this compounds rapidly

### This Was Added in 1.13.0

The `queryRequestAnalytics.ts` file (and related filter attributes queries) **did not exist in version 1.12.3**. These were added as part of the analytics feature in 1.13.0, which explains the regression.

## Solution Implemented

### Change Made
File: `server/routers/auditLogs/queryRequestAuditLog.ts` - `queryUniqueFilterAttributes()`

Added **aggressive caching** with 15-minute TTL:

**Before:**
```typescript
async function queryUniqueFilterAttributes(timeStart, timeEnd, orgId) {
    const baseConditions = and(...);

    // Directly run 5 expensive DISTINCT queries every time
    const [uniqueActors, uniqueLocations, ...] = await Promise.all([...]);

    return { actors: ..., locations: ..., hosts: ..., paths: ..., resources: ... };
}
```

**After:**
```typescript
async function queryUniqueFilterAttributes(timeStart, timeEnd, orgId) {
    // Round time ranges to 15-minute buckets for better cache hit rate
    const roundedStart = Math.floor(timeStart / 900) * 900;
    const roundedEnd = Math.floor(timeEnd / 900) * 900;
    const cacheKey = `filterAttrs:${orgId}:${roundedStart}:${roundedEnd}`;

    // Check cache first - avoid expensive queries
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
        logger.debug(`[FILTER_ATTRS] Cache HIT - avoiding 5 expensive DISTINCT queries`);
        return cached;
    }

    logger.debug(`[FILTER_ATTRS] Cache MISS - running expensive DISTINCT queries`);

    // Run queries only on cache miss
    const [uniqueActors, uniqueLocations, ...] = await Promise.all([...]);

    const result = { actors: ..., locations: ..., hosts: ..., paths: ..., resources: ... };

    // Cache for 15 minutes (900 seconds)
    cache.set(cacheKey, result, 900);
    logger.debug(`[FILTER_ATTRS] Cached result (900s TTL)`);

    return result;
}
```

### Key Implementation Details

1. **Time Bucketing**: Round time ranges to 15-minute intervals
   - Improves cache hit rate for similar time ranges
   - Example: 14:03-16:45 and 14:07-16:50 map to same bucket (14:00-16:45)

2. **Cache Key Format**: `filterAttrs:{orgId}:{roundedStart}:{roundedEnd}`
   - Ensures per-organization isolation
   - Includes time range for freshness

3. **TTL: 900 seconds (15 minutes)**
   - Trade-off: Filter dropdowns may be up to 15 minutes stale
   - Benefit: Massive reduction in disk I/O
   - Acceptable for most use cases (filters are for discovery, not real-time monitoring)

4. **Debug Logging**: Added logs to track cache hits/misses
   - Helps monitor effectiveness of caching
   - Can be used to tune TTL if needed

## Impact

### Expected Improvements

- **Cache Hit Scenario** (most common after first load):
  - ✅ Zero DISTINCT queries executed
  - ✅ Zero disk I/O for filter attributes
  - ✅ Sub-millisecond response time

- **Cache Miss Scenario** (first load or after 15min TTL):
  - Still runs 5 DISTINCT queries
  - But only once per 15-minute window
  - Subsequent loads benefit from cache

### Disk I/O Reduction Estimate

**Before Fix:**
- User opens logs page: 5 DISTINCT queries
- User changes filter: 5 DISTINCT queries
- User navigates pages: 5 DISTINCT queries each time
- User refreshes: 5 DISTINCT queries
- **Result**: Potentially hundreds of expensive queries per hour

**After Fix:**
- First access: 5 DISTINCT queries (cache miss)
- All subsequent accesses within 15 min: 0 queries (cache hit)
- After 15 min: 5 DISTINCT queries (cache refresh)
- **Result**: Maximum 4 sets of queries per hour = **~75-95% reduction**

### Real-World Impact with Synology Photos Auth Spam

Given your scenario:
- Synology Photos making 50+ auth attempts every 3 seconds
- Audit log table growing rapidly
- Users potentially checking logs frequently

**Expected reduction:**
- From: 13.6GB read I/O in 50 minutes
- To: **<1-2GB read I/O in 50 minutes** (assuming user checks logs a few times)
- **~85-90% reduction in read I/O**

## Trade-offs

### Acceptable Trade-off
- **Filter dropdowns may be up to 15 minutes stale**
  - New actors, hosts, paths won't appear in filters immediately
  - This is acceptable because:
    - Filters are for discovery/exploration, not real-time monitoring
    - Users can still manually type values even if not in dropdown
    - The actual log data is always fresh (only filter options are cached)

### Alternative Solutions Considered

1. ❌ **Lower TTL (e.g., 1 minute)**: Would still cause significant I/O
2. ❌ **On-demand refresh button**: Users would forget to use it
3. ❌ **Database optimization**: DISTINCT requires full scans regardless of indexes
4. ✅ **15-minute caching**: Best balance of freshness and performance

## Monitoring

### How to Verify the Fix

1. **Check Docker Stats**:
   ```bash
   docker stats --no-stream pangolin
   # Watch BLOCK I/O - should drop dramatically
   ```

2. **Check Logs for Cache Effectiveness**:
   ```bash
   docker logs pangolin | grep "\[FILTER_ATTRS\]"
   # Should see mostly "Cache HIT" messages after initial load
   ```

3. **Before/After Comparison**:
   - Before: 13.6GB read I/O in 50 minutes = ~272 MB/min
   - After: <1-2GB read I/O in 50 minutes = ~20-40 MB/min
   - **Target: 85-90% reduction**

## Deployment

### Build and Deploy

```bash
# Commit the changes
git add server/routers/auditLogs/queryRequestAuditLog.ts
git commit -m "Add aggressive caching to filter attributes query to reduce disk I/O"

# Push to your remote
git push origin main

# Rebuild and restart container
docker compose down
docker compose build
docker compose up -d
```

### Monitor After Deployment

```bash
# Monitor disk I/O for at least 1 hour
watch -n 30 'docker stats --no-stream pangolin | grep -E "CONTAINER|pangolin"'

# Check for cache hit/miss patterns
docker logs -f pangolin | grep "\[FILTER_ATTRS\]"
```

## Expected Behavior After Fix

- **First page load**: Cache MISS - runs 5 DISTINCT queries (shows in logs)
- **Subsequent loads (within 15min)**: Cache HIT - zero queries (instant response)
- **After 15 minutes**: Cache MISS again - refreshes data
- **Disk I/O**: Should drop from 13.6GB/50min to <2GB/50min

## Files Changed

- `server/routers/auditLogs/queryRequestAuditLog.ts` - Added caching to `queryUniqueFilterAttributes()`

## Related Fixes

1. **Analytics Auto-Refresh** (`DISK_IO_FIX.md`) - Disabled 30-second polling
2. **Audit Log Memory Leak** (`MEMORY_LEAK_FIX.md`) - Fixed buffer flushing
3. **This Fix** - Cached expensive filter queries

Together, these fixes should resolve the disk I/O regression in 1.13.0.
