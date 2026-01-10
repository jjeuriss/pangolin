# Pangolin Memory Leak Fix - Unbounded Fetch Timeouts

## Problem Summary

Pangolin is experiencing severe memory thrashing on small VPS systems (860MB RAM) due to **unbounded HTTP requests without timeout configurations**. When external resources become unresponsive, these requests accumulate indefinitely in memory, causing:

- Memory pressure spikes
- Swap thrashing (endless disk I/O)
- System freezes
- Complete OOM exhaustion of zram swap

## Root Cause Analysis

### Issue 1: Fetch without Timeout in `src/actions/server.ts` - CRITICAL 🔴

**File:** `src/actions/server.ts`  
**Function:** `makeApiRequest<T>()` (lines ~70-100)  
**Severity:** CRITICAL - Used for authentication, OIDC, and all proxy routes

**Current Code (lines 92-99):**
```typescript
let res: Response;
try {
    res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store"
    });
```

**Problem:** The `fetch()` call has **NO timeout parameter** and **NO AbortController**. When the target server becomes unresponsive, the request hangs indefinitely until browser timeout (~minutes), accumulating memory resources.

**Called by these proxy functions:**
- `loginProxy()`
- `securityKeyStartProxy()`
- `validateOidcUrlCallbackProxy()`
- `generateOidcUrlProxy()`
- All other proxy functions that forward requests to configured endpoints

**Fix:** Add AbortController with 10-second timeout

```typescript
let res: Response;
try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        signal: controller.signal
    });
    
    clearTimeout(timeoutId);
```

Also need to handle AbortError in the catch block:
```typescript
} catch (fetchError) {
    console.error("API request failed:", fetchError);
    
    // Handle abort/timeout errors specifically
    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        console.error("API request timeout (10s exceeded)");
    }
    
    return {
        data: null,
        success: false,
        error: true,
        message: "Failed to connect to server. Please try again.",
        status: 0
    };
}
```

---

### Issue 2: Axios Calls without Timeout in `server/lib/exitNodes/exitNodeComms.ts` - CRITICAL 🔴

**File:** `server/lib/exitNodes/exitNodeComms.ts`  
**Function:** `sendToExitNode()` (lines ~22-86)  
**Severity:** CRITICAL - Handles exit node communication to user-configured endpoints

**Current Code Issues:**
```typescript
// POST without timeout
case "POST":
    response = await axios.post(url, request.data, {
        headers: {
            "Content-Type": "application/json"
        }
        // NO timeout!
    });
    break;

// DELETE without timeout
case "DELETE":
    response = await axios.delete(url);  // NO timeout!
    break;

// GET without timeout
case "GET":
    response = await axios.get(url);  // NO timeout!
    break;

// PUT without timeout
case "PUT":
    response = await axios.put(url, request.data, {
        headers: {
            "Content-Type": "application/json"
        }
        // NO timeout!
    });
    break;
```

**Fix:** Add `timeout: 8000` (8 seconds) to all axios calls - matches the timeout in the private version of this file:

```typescript
case "POST":
    response = await axios.post(url, request.data, {
        headers: {
            "Content-Type": "application/json"
        },
        timeout: 8000
    });
    break;

case "DELETE":
    response = await axios.delete(url, { timeout: 8000 });
    break;

case "GET":
    response = await axios.get(url, { timeout: 8000 });
    break;

case "PUT":
    response = await axios.put(url, request.data, {
        headers: {
            "Content-Type": "application/json"
        },
        timeout: 8000
    });
    break;
```

---

## Why These Fixes Work

1. **AbortController/Timeout prevents unbounded waiting** - Requests that would hang for minutes instead fail after 8-10 seconds
2. **Memory released faster** - Failed requests are cleaned up quickly instead of accumulating
3. **Prevents cascading failures** - Timeouts propagate up, preventing retry loops that accumulate more requests
4. **System remains responsive** - No more memory pressure spikes from hung requests

## Testing Steps After Fix

1. **Rebuild the Docker image:**
   ```bash
   docker build -t pangolin:fixed .
   ```

2. **Stop the current container:**
   ```bash
   docker stop pangolin
   ```

3. **Run the fixed container:**
   ```bash
   docker run -d --name pangolin-fixed \
     --memory=512m \
     --restart unless-stopped \
     -v pangolin-config:/app/config \
     -p 3000:3000 \
     pangolin:fixed
   ```

4. **Monitor memory usage:**
   ```bash
   docker stats pangolin-fixed
   watch -n 2 'free -h && swapon --show'
   ```

5. **Reproduce the problem** - Access URLs that would cause timeouts/hanging before, verify:
   - Requests fail quickly (8-10 seconds)
   - Memory doesn't accumulate
   - Swap doesn't fill up
   - System remains responsive

## Reference: Correctly Configured Examples in Codebase ✅

These show the pattern that should be used everywhere:

- `server/private/lib/exitNodes/exitNodeComms.ts` - **8000ms timeout** on axios ✅
- `src/lib/api/index.ts` - **10000ms timeout on axios instances** ✅
- `server/routers/site/listSites.ts` - **1500ms timeout via AbortController** ✅

## Files to Modify

1. `src/actions/server.ts` - Add AbortController + timeout to `makeApiRequest()`
2. `server/lib/exitNodes/exitNodeComms.ts` - Add `timeout: 8000` to all axios calls (POST, GET, PUT, DELETE)

## Testing

Comprehensive test suites have been created to verify the fixes work correctly:

### Test Files
- `test/memoryLeakFetch.test.ts` - Tests fetch API timeout implementation
- `test/memoryLeakAxios.test.ts` - Tests axios timeout implementation
- `test/runMemoryLeakTests.ts` - Master test runner for both suites
- `test/README.md` - Complete test documentation

### Running Tests

```bash
# Run all memory leak tests
npm run test:memory-leak

# Run individual test suites
npm run test:memory-leak:fetch
npm run test:memory-leak:axios
```

The tests verify:
- ✅ Timeouts trigger at the correct intervals (10s for fetch, 8s for axios)
- ✅ Hanging servers are properly aborted
- ✅ Fast responses complete successfully
- ✅ Timeout handlers are cleaned up to prevent leaks
- ✅ Multiple concurrent timeouts don't accumulate
- ✅ Error handling works correctly for timeout scenarios

See `test/README.md` for detailed test documentation.

---

**Related VPS Setup:** These fixes complement the zram swap optimization applied earlier. Together they solve:
- ✅ Memory thrashing (zram)
- ✅ Unbounded request accumulation (these timeouts)
- ✅ System freezes (both)
