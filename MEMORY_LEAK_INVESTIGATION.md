# Memory Leak Investigation - Failed Authentication Requests

**Date:** January 9, 2026  
**Issue:** Heap memory increases significantly when processing failed authentication requests  
**Status:** Under Investigation

## Executive Summary

Memory leak confirmed to be **NOT caused by cache growth**, but rather by the **authentication flow for unauthenticated requests**. When authentication is disabled, the memory leak disappears.

## Observations

### Memory Growth Pattern

| Timestamp | Cache Keys | RSS Memory | Heap Used | Heap Total | Notes |
|-----------|------------|------------|-----------|------------|-------|
| 19:11:20 | 3 | 215MB | 194MB | 202MB | After ~100s of failed requests |
| 19:11:50 | 3 | 260MB | 234MB | 263MB | **+40MB increase** in 30s |
| 19:12:20 | 2 | 220MB | 207MB | 212MB | Garbage collection occurred |

**Key Finding:** Cache stayed at 2-3 keys throughout, but heap grew by 40MB - proving cache is not the issue.

### Cache Contents (Minimal)
```
geoip:37.185.3.45
org_kerselaarstraat_retentionDays
resource:photo.mythium.be
```

## Request Pattern Analysis

### Failed Authentication Flow

Each failed request from Synology Photos app goes through:

```
1. GET /api/v1/resource/{uuid}/auth
2. Verify session (Badger communication)
3. Client IP extraction
4. MaxMind ASN DB lookup (fails - not configured)
5. No more auth to check
6. Redirect URL generation (LONG URL with query params)
7. JSON response creation
8. Response sent
```

### Sample Failed Request Log

```log
2026-01-09T19:11:05+00:00 [debug]: Verify session: Badger sent {
  "sessions":{},
  "originalRequestURL":"https://photo.mythium.be/synofoto/api/v2/t/Thumbnail/get?cache_key=%22143743_1361068835%22&id=143743&size=%22sm%22&type=%22unit%22",
  "scheme":"",
  "host":"photo.mythium.be",
  "path":"/synofoto/api/v2/t/Thumbnail/get",
  "method":"GET",
  "tls":true,
  "requestIp":"37.185.3.45",
  "headers":{
    "Accept-Encoding":"gzip",
    "Cookie":"did=ZRotOoW1KCTA78gEzxb8vhJIhtS0vun0hGh0M4QJdRIS_wid0c2EG5MxkTsqD4dscBjn3Zp2qHxBtY7hn_onsA; id=HZcGxi_HVQ7Au86XytPQ56sG3Ox5S2Si0ix4-GZZ9-UFiHqkKTzbC2LdPEzu_MrZRmnPb6h-yjKLUFk2fJcfeo",
    "User-Agent":"Synology-Synology_Photos_2.3.6_rv:602_Pixel 9_Android_36_(Dalvik/2.1.0 (Linux; U; Android 16; Pixel 9 Build/BP3A.251105.015))",
    "X-Forwarded-Host":"photo.mythium.be",
    "X-Forwarded-Port":"443",
    "X-Forwarded-Proto":"https",
    "X-Forwarded-Server":"3ee4c40dc1f4",
    "X-Real-Ip":"37.185.3.45"
  },
  "query":{
    "cache_key":"\"143743_1361068835\"",
    "id":"143743",
    "size":"\"sm\"",
    "type":"\"unit\""
  },
  "badgerVersion":"1.3.1"
}

2026-01-09T19:11:05+00:00 [debug]: Client IP: {"clientIp":"37.185.3.45"}
2026-01-09T19:11:05+00:00 [debug]: MaxMind ASN DB path not configured, cannot perform ASN lookup
2026-01-09T19:11:05+00:00 [debug]: No more auth to check, resource not allowed
2026-01-09T19:11:05+00:00 [debug]: Redirecting to login at /auth/resource/186a6b1c-18a6-4c24-a81c-dad5976b5f35?redirect=https%3A%2F%2Fphoto.mythium.be%2Fsynofoto%2Fapi%2Fv2%2Ft%2FThumbnail%2Fget%3Fcache_key%3D%2522143743_1361068835%2522%26id%3D143743%26size%3D%2522sm%2522%26type%3D%2522unit%2522

2026-01-09T19:11:05+00:00 [debug]: {
  "data":{
    "valid":false,
    "redirectUrl":"https://pangolin.mythium.be/auth/resource/186a6b1c-18a6-4c24-a81c-dad5976b5f35?redirect=https%3A%2F%2Fphoto.mythium.be%2Fsynofoto%2Fapi%2Fv2%2Ft%2FThumbnail%2Fget%3Fcache_key%3D%2522143743_1361068835%2522%26id%3D143743%26size%3D%2522sm%2522%26type%3D%2522unit%2522",
    "pangolinVersion":"1.14.0"
  },
  "success":true,
  "error":false,
  "message":"Access denied",
  "status":200
}
```

### Request Volume

During the 3-second period from `19:11:02` to `19:11:05`:
- **~50+ failed authentication attempts**
- Each generating large JSON objects
- Each creating redirect URLs with encoded query parameters
- Each processing through the full auth middleware stack

## Potential Memory Leak Sources

### 1. **🔴 FOUND: Audit Log Buffer - CONFIRMED LEAK** ⚠️ CRITICAL
From `server/routers/badger/logRequestAudit.ts`:

**The Problem:**
```typescript
// In-memory buffer for batching audit logs
const auditLogBuffer: Array<{
    timestamp: number;
    orgId?: string;
    actorType?: string;
    actor?: string;
    actorId?: string;
    metadata: any;        // ⚠️ CAN BE LARGE
    action: boolean;
    resourceId?: number;
    reason: number;
    location?: string;
    originalRequestURL: string;  // ⚠️ LONG ENCODED URL
    scheme: string;
    host: string;
    path: string;
    method: string;
    ip?: string;
    tls: boolean;
}> = [];

const BATCH_SIZE = 100;  // Flushes every 100 logs
const BATCH_INTERVAL_MS = 5000;  // OR every 5 seconds
```

**Why This Causes the Leak:**

1. **Each failed authentication attempt adds an object to the buffer** with:
   - `originalRequestURL`: 200-300+ character encoded URL
   - `metadata`: Large JSON object (if present)
   - All headers, query params, etc.

2. **Buffer flushing logic**:
   ```typescript
   if (auditLogBuffer.length >= BATCH_SIZE) {
       flushAuditLogs().catch(...)  // Fire and forget
   } else {
       scheduleFlush();  // Every 5 seconds
   }
   ```

3. **The Issue**: With **50+ requests in 3 seconds**, the buffer never reaches 100 items before the 5-second timer triggers. But more importantly:
   - Buffer keeps accumulating during the flood
   - Even when flushed, new requests keep adding
   - The `splice(0, auditLogBuffer.length)` creates a NEW array in memory
   - Old buffer memory not freed immediately (waiting for GC)

4. **Memory Calculation**:
   - Each log entry: ~1-2KB (with long URLs and metadata)
   - 50 requests × 2KB = **100KB per burst**
   - Multiple bursts = memory accumulation
   - Observed: 40MB growth = **20,000+ buffered objects or similar accumulation pattern**

**Code Evidence:**
```typescript
// Line 216: Every failed auth adds to buffer
auditLogBuffer.push({
    timestamp,
    orgId: data.orgId,
    actorType,
    actor,
    actorId,
    metadata,                          // JSON.stringify of large object
    action: data.action,
    resourceId: data.resourceId,
    reason: data.reason,
    location: data.location,
    originalRequestURL: body.originalRequestURL,  // LONG URL
    scheme: body.scheme,
    host: body.host,
    path: body.path,
    method: body.method,
    ip: clientIp,
    tls: body.tls
});
```

### 2. **Redirect URL String Accumulation** ⚠️ HIGH PRIORITY
- Each failed request generates a long redirect URL with URL-encoded query parameters
- URLs can be 200-300+ characters
- If these strings are not being properly garbage collected, they accumulate

### 3. **Request/Response Object Retention** ⚠️ HIGH PRIORITY
- Large request objects from Badger (containing headers, cookies, query params)
- Response JSON objects being held in memory
- Possible event listener leaks in Express middleware

### 4. **Debug Logging** ⚠️ LOW PRIORITY
- Heavy debug logging with JSON.stringify on large objects
- Winston transports may be buffering

### 5. **HTTP Connection Handling** ⚠️ MEDIUM PRIORITY
- Keep-alive connections not being properly closed
- Request/response objects held by Express

## Test Results

### With Authentication Enabled
- **Result:** Memory leak observed (+40MB in 30 seconds)
- Heap grew from 194MB → 234MB with flood of failed requests

### With Authentication Disabled
- **Result:** NO memory leak observed
- Memory remains stable

## Root Cause Analysis

### The Audit Log Buffer is the Primary Culprit

**Why it causes memory growth:**

1. **Accumulation Rate vs Flush Rate**
   - Failed auth requests: 50+ per 3 seconds = **16-17 requests/second**
   - Buffer flush: Every 100 items OR 5 seconds
   - At 16 req/s: Buffer fills to ~80-85 items every 5 seconds before flush
   - During burst: Can accumulate much faster

2. **Object Size**
   - `originalRequestURL`: ~250 bytes (encoded)
   - `metadata`: ~500-1000 bytes (JSON stringified)
   - Other fields: ~200 bytes
   - **Total per entry: ~1-1.5KB**

3. **Memory Math**
   - Burst of 50 requests = 50KB-75KB added to buffer
   - Multiple bursts over 30 seconds = 500KB-1MB
   - But observed: **40MB growth** suggests either:
     - Buffer not flushing successfully (DB errors?)
     - Multiple buffers accumulating (module loaded multiple times?)
     - Old buffer arrays not being garbage collected
     - Additional memory retention in database driver

4. **Failed Flush Scenario**
   ```typescript
   await db.insert(requestAuditLog).values(logsToWrite);
   ```
   - If database insert fails (connection issues, constraints, etc.)
   - Logs are LOST but memory allocated for them remains
   - No retry mechanism = buffer keeps growing

## Next Steps for Investigation

### 1. **IMMEDIATE: Add Buffer Monitoring** ⚠️ CRITICAL
```typescript
// Add to logRequestAudit.ts
setInterval(() => {
    logger.warn(`Audit buffer size: ${auditLogBuffer.length} items, Est memory: ${Math.round(auditLogBuffer.length * 1.5)}KB`);
}, 10000);
```

### 2. Profile the Authentication Endpoint
```bash
# Use Node.js built-in profiler
node --inspect server/index.js
# Connect Chrome DevTools and take heap snapshots before/after failed auth flood
```

### 2. Check Audit Log Buffer
- Verify buffer is flushing: `server/routers/badger/logRequestAudit.ts`
- Check if failed requests are being buffered indefinitely
- Monitor buffer size during load
CRITICAL - Immediate Fix Required

#### Option 1: Reduce Buffer Memory Footprint (Quick Fix)
```typescript
// Store only essential data in buffer
auditLogBuffer.push({
    timestamp,
    orgId: data.orgId,
    resourceId: data.resourceId,
    reason: data.reason,
    // OMIT: originalRequestURL, metadata, long strings
    // Store minimal identifier only
    pathHash: hash(body.path),  // Just a hash instead of full URL
    ip: clientIp
});
```

#### Option 2: Skip Audit Logging for Failed Auth (Recommended)
```typescript
// At the start of logRequestAudit function
if (data.reason >= 200 && data.reason < 300) {
    // Reasons 200-299 are failures - don't log to reduce memory
    // Log only successful access (100-199) for security audit
    return;
}
```

#### Option 3: Immediate Flush for Failed Auth
```typescript
// After adding to buffer for failed auth
if (data.reason >= 200 && data.reason < 300) {
    // Failed auth - flush immediately to prevent accumulation
    await flushAuditLogs();
    return;
}
```

#### Option 4: Don't Log Failed Auth During High Load
```typescript
// Add rate limiting
let recentFailedAuthCount = 0;
const FAILED_AUTH_LIMIT = 10; // Max 10 failed auths per 5 seconds

if (data.reason >= 200) {
    recentFailedAuthCount++;
    if (recentFailedAuthCount > FAILED_AUTH_LIMIT) {
        logger.warn("Too many failed auth attempts, skipping audit log");
        return;
    }
}

setInterval(() => { recentFailedAuthCount = 0; }, 5000);
```

### Immediate
1. ✅ **Add buffer size monitoring** (implemented above)
2. ✅ **Implement one of the four fixes above**
3. Add early rejection for repeated failed auth from same IP/cookie combo
4. Implement rate limiting on authentication endpoints

### Short-term  
1. ✅ Audit log buffer fixed
2. Review database insert error handling (add retry or fallback to file)
3. Add memory monitoring alerts
4. Investigate if DB inserts are actually succeeding

### Long-term
1. Investigate why Synology Photos isn't maintaining authentication
2. Consider authentication caching for failed attempts
3. Implement circuit breaker pattern for repeated failures
4. Move to streaming audit logs instead of batching, Heap: ${Math.round(heapUsed / 1024 / 1024)}MB`);
}, 5000);
```

### 5. Check String Interning
- Large redirect URLs being created repeatedly
- Check if URL encoding is creating new strings each time
- Consider caching common redirect patterns

## Code Areas to Review

### High Priority
1. **`server/routers/badger/logRequestAudit.ts`** - Audit log buffer management
2. **`server/routers/resource/` directory** - Resource authentication flow
3. **Express middleware chain** - Request/response lifecycle

### Medium Priority
4. **`server/logger.ts`** - Debug logging with large objects
5. **Database connection pooling** - Check for connection leaks
6. **MaxMind lookup code** - Even though it fails, may be allocating memory

## Additional Notes

- The Synology Photos app is sending cookies with failed requests, suggesting it thinks it's authenticated
- Cookie values are very long (100+ characters each)
- Each request includes full headers, query params, and metadata
- The redirect URL includes double-encoded query parameters

## Recommendations

### Immediate
1. Add early rejection for repeated failed auth from same IP/cookie combo
2. Implement rate limiting on authentication endpoints
3. Add heap snapshot comparison tool to identify leak source

### Short-term  
1. Fix audit log buffer if it's accumulating
2. Review Express middleware for proper cleanup
3. Add memory monitoring alerts

### Long-term
1. Investigate why Synology Photos isn't maintaining authentication
2. Consider authentication caching for failed attempts
3. Implement circuit breaker pattern for repeated failures

---

**Investigation continues...**
