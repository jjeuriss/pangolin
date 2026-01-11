# Root Cause Analysis: Disk I/O Investigation
**Status**: Narrowing down - systematic feature disablement strategy
**Date**: 2026-01-11
**Approach**: Turn off features in priority order until disk I/O issue disappears

---

## Analysis Summary

### What We Know (High Confidence)
1. **Trigger**: High volume of unauthenticated requests (50+/sec)
2. **Symptom**: 2.36GB disk I/O in 7 minutes, OOM crashes
3. **When It Started**: v1.13.0 (comparing to v1.12.3 works fine)
4. **Previous Fixes That Didn't Work**:
   - ❌ Cache stampede fix on `getRetentionDays()` (COMMIT 97645964)
   - ❌ Skip audit logging for unauthenticated requests (COMMIT feb8fbb8)
   - ❌ Database index on `resources.fullDomain` (COMMIT bb8d8292 + 2ccc92a1)

### Why Previous Fixes Failed
These were **targeted optimizations** of code paths we assumed were problematic, but they only reduced symptoms, not eliminated them. We were fixing individual queries instead of identifying which **entire feature** is the culprit.

**Example**: Adding an index helped, but disk I/O didn't actually go down significantly because:
- The index query wasn't the main problem
- Multiple other queries were still firing

### Current Best Guess (Not Yet Verified)
The **Request Audit Logging System** (`logRequestAudit.ts`) is the #1 suspect because:
1. It's NEW in v1.13.0
2. It calls `getRetentionDays()` on EVERY request
3. With 50+ req/sec, this becomes 50+ DB queries/sec
4. Short cache TTL (1 hour) means frequent misses

But this is still a **guess**. We need hard data.

---

## Why We're Changing Strategy

**Old approach**: "Optimize what we think is slow"
- Result: Guessing wrong, making small improvements that don't solve the problem
- Time waste: Multiple commits that didn't help

**New approach**: "Turn off features until the problem goes away"
- Result: Identify the actual culprit with certainty
- Time investment: Systematic, methodical, guaranteed to find the root cause

### Key Principle
**Each iteration must be measurable**:
- Disable one feature
- Rebuild/restart container
- Run same load test (200 unauthenticated requests)
- Check disk I/O growth
- Document result
- Re-enable and move to next feature

---

## Feature Disablement Priority Order

### Phase 1: High Suspicion (Likely Culprits)

**#1 - Request Audit Logging System** (PRIMARY SUSPECT)
- **File**: `server/routers/badger/logRequestAudit.ts`
- **Why Suspicious**:
  - NEW in v1.13.0
  - Triggered on EVERY request
  - Queries database multiple times
  - Called from `verifySessionMiddleware.ts`
- **How to Disable**: Skip audit logging entirely for testing
- **Expected Result**: If this is it, disk I/O drops dramatically
- **Risk**: Low - just skipping logging

**#2 - Session Verification Queries** (HIGH SUSPICION)
- **File**: `server/db/queries/verifySessionQueries.ts`
- **Why Suspicious**:
  - 6 NEW query functions added in v1.13.0
  - Called during auth/verification flow
  - May lack indexes or have N+1 queries
- **How to Disable**: Stub out these queries (return empty/cached results)
- **Expected Result**: If this is it, disk I/O drops
- **Risk**: Low - we can mock the results

**#3 - Log Analytics & Aggregation** (HIGH SUSPICION)
- **File**: `server/routers/auditLogs/queryRequestAnalytics.ts`
- **Why Suspicious**:
  - Complex aggregation queries
  - May be triggered during request flow
  - Could scan entire audit log table
- **How to Disable**: Skip analytics entirely for testing
- **Expected Result**: If this is it, disk I/O drops
- **Risk**: Low - just skipping analytics

**#4 - Database Schema Changes / Missing Indexes** (MEDIUM-HIGH)
- **Files**: `server/db/sqlite/schema/schema.ts`, `server/db/pg/schema/schema.ts`
- **Why Suspicious**:
  - New tables/columns added in v1.13.0
  - May not have proper indexes
  - Could trigger full table scans
- **How to Disable**: Add missing indexes proactively (the v1.14.1 fix attempted this)
- **Expected Result**: If this is it, indexes solve it
- **Risk**: Medium - need to know which indexes

**#5 - Enhanced Session Verification Logic** (MEDIUM)
- **File**: `server/auth/sessions/verifySession.ts`
- **Why Suspicious**:
  - New device authentication checks
  - Additional auth steps = more DB queries
- **How to Disable**: Skip new auth checks for testing
- **Expected Result**: If this is it, disk I/O drops
- **Risk**: Low - just skipping new security checks temporarily

### Phase 2: Medium Suspicion

**#6 - User Clients Calculation** (MEDIUM)
- **File**: `server/lib/calculateUserClientsForOrgs.ts`
- **Why Suspicious**: Nested/looping queries
- **How to Disable**: Return empty results for testing
- **Risk**: Low

**#7 - Log Cleanup System** (MEDIUM)
- **File**: `server/lib/cleanupLogs.ts`
- **Why Suspicious**: DELETE operations on large tables
- **How to Disable**: Disable scheduled cleanup
- **Risk**: Low - just skip cleanup

**#8 - Blueprint Enhancements** (MEDIUM-LOW)
- **Files**: `server/db/queries/blueprints/`
- **Why Suspicious**: Complex associations
- **How to Disable**: Return simpler results
- **Risk**: Medium

---

## Testing Methodology

### Standard Test Protocol (Reusable for Each Feature)

```bash
# 1. Create baseline measurement
docker exec pangolin /bin/bash -c "
  READ_BEFORE=\$(cat /proc/diskstats | grep -w sda | awk '{print \$6}')
  # Wait a few seconds
  sleep 5
  READ_AFTER=\$(cat /proc/diskstats | grep -w sda | awk '{print \$6}')
  echo \"Baseline: \$((READ_AFTER - READ_BEFORE)) sectors\"
"

# 2. Run load test (200 unauthenticated requests)
# Use load test script from previous investigation

# 3. Measure final I/O
docker exec pangolin /bin/bash -c "
  READ_BEFORE=\$(cat /proc/diskstats | grep -w sda | awk '{print \$6}')
  # Wait during load test
  sleep 10
  READ_AFTER=\$(cat /proc/diskstats | grep -w sda | awk '{print \$6}')
  echo \"Growth: \$((READ_AFTER - READ_BEFORE)) sectors\"
"
```

### Success Criteria
- **CULPRIT FOUND**: Disk I/O drops to <100kB (same as v1.12.3)
- **Not culprit**: I/O stays at 2.36GB+, re-enable and move to next

---

## Implementation Status: COMPLETE ✅

### Files Modified with Feature Flags:

| File | Flag | What It Disables |
|------|------|-----------------|
| `server/lib/featureFlags.ts` | (new file) | Central feature flag system |
| `server/routers/badger/logRequestAudit.ts` | `DISABLE_AUDIT_LOGGING` | All audit log writes |
| `server/db/queries/verifySessionQueries.ts` | `DISABLE_SESSION_QUERIES` | All 6 DB query functions |
| `server/lib/geoip.ts` | `DISABLE_GEOIP_LOOKUP` | MaxMind country lookups |
| `server/lib/asn.ts` | `DISABLE_ASN_LOOKUP` | MaxMind ASN lookups |
| `server/routers/badger/verifySession.ts` | `DISABLE_RULES_CHECK` | Rule evaluation logic |

### Available Environment Variables:

```bash
# Phase 1: High Suspicion
DISABLE_AUDIT_LOGGING=true      # Skips all logRequestAudit() calls
DISABLE_SESSION_QUERIES=true    # Returns null/empty from all DB queries
DISABLE_GEOIP_LOOKUP=true       # Skips MaxMind country code lookup
DISABLE_ASN_LOOKUP=true         # Skips MaxMind ASN lookup
DISABLE_RULES_CHECK=true        # Skips rule evaluation entirely

# Phase 2: Medium Suspicion (not yet implemented)
DISABLE_LOG_CLEANUP=true        # Skips background log cleanup
```

### How to Test Each Feature:

```bash
# Test 1: Disable Audit Logging
docker run -e DISABLE_AUDIT_LOGGING=true ... jjeuriss/pangolin:test

# Test 2: Disable Session Queries (returns "resource not found" for all)
docker run -e DISABLE_SESSION_QUERIES=true ... jjeuriss/pangolin:test

# Test 3: Disable GeoIP + ASN (skips file I/O)
docker run -e DISABLE_GEOIP_LOOKUP=true -e DISABLE_ASN_LOOKUP=true ... jjeuriss/pangolin:test

# Test 4: Disable Rules Check
docker run -e DISABLE_RULES_CHECK=true ... jjeuriss/pangolin:test
```

---

## Next Steps: Run Tests

1. Build Docker image with current changes
2. Deploy to VPS
3. Run each test scenario (one flag at a time)
4. Measure disk I/O after 200 unauthenticated requests
5. Document which flag eliminates the disk I/O issue

---

## Expected Timeline

- **Per feature**: 15-20 minutes (rebuild, test, document)
- **Total investigation**: 2-3 hours for all features
- **If found in first 1-2 tests**: 30-60 minutes total
- **Once identified**: 1-2 hours to properly optimize

---

## What Success Looks Like

At the end of this investigation, we will have:
1. ✅ Identified the exact feature causing disk I/O
2. ✅ Proven it with hard test data
3. ✅ Documented the root cause clearly
4. ✅ Clear understanding of what to optimize

Then we can **confidently optimize** the real culprit instead of guessing.

---

## Files to Modify (Prepared for Disablement)

These will be modified to add feature flags:
- `server/routers/badger/logRequestAudit.ts`
- `server/db/queries/verifySessionQueries.ts`
- `server/routers/auditLogs/queryRequestAnalytics.ts`
- `server/auth/sessions/verifySession.ts`
- `server/lib/calculateUserClientsForOrgs.ts`
- `server/lib/cleanupLogs.ts`
- `server/db/queries/blueprints/index.ts`

---

## Notes for Future Reference

- **Commit hash at investigation start**: `2ccc92a1` (v1.14.1)
- **Base version working (no I/O issue)**: v1.12.3
- **First version with issue**: v1.13.0
- **Docker container**: `jjeuriss/pangolin:latest`
- **Database**: SQLite at `/data/pangolin.db`
- **Test trigger**: Synology Photos app making 50+ req/sec unauthenticated requests

---

## Completed Iterations

| Feature | Status | Result | Disk I/O | Notes |
|---------|--------|--------|----------|-------|
| (To be filled during testing) | | | | |

---

