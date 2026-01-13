/**
 * Memory Profiler for Disk I/O Investigation
 *
 * Tracks memory usage over time to identify memory leaks.
 * Logs detailed heap and cache statistics every 10 seconds.
 */

import logger from "@server/logger";
import cache from "@server/lib/cache";

interface MemorySnapshot {
    timestamp: number;
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    arrayBuffersMB: number;
    rssMB: number;
    cacheKeys: number;
    cacheHits: number;
    cacheMisses: number;
}

const snapshots: MemorySnapshot[] = [];
const MAX_SNAPSHOTS = 360; // Keep 1 hour of data at 10-second intervals

let requestCount = 0;
let lastRequestCount = 0;

export function incrementRequestCount() {
    requestCount++;
}

function takeSnapshot(): MemorySnapshot {
    const mem = process.memoryUsage();
    const cacheStats = cache.getStats();

    return {
        timestamp: Date.now(),
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        externalMB: Math.round(mem.external / 1024 / 1024),
        arrayBuffersMB: Math.round((mem.arrayBuffers || 0) / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        cacheKeys: cacheStats.keys,
        cacheHits: cacheStats.hits,
        cacheMisses: cacheStats.misses
    };
}

function logMemoryStatus() {
    const snapshot = takeSnapshot();
    snapshots.push(snapshot);

    // Keep only last MAX_SNAPSHOTS
    if (snapshots.length > MAX_SNAPSHOTS) {
        snapshots.shift();
    }

    // Calculate request rate
    const reqPerSec = (requestCount - lastRequestCount) / 10;
    lastRequestCount = requestCount;

    // Calculate memory growth rate (over last minute if we have enough data)
    let heapGrowthPerMin = 0;
    if (snapshots.length >= 6) {
        const oneMinuteAgo = snapshots[snapshots.length - 6];
        heapGrowthPerMin = snapshot.heapUsedMB - oneMinuteAgo.heapUsedMB;
    }

    // Log current status
    logger.info(
        `[MEMORY_PROFILER] ` +
        `Heap: ${snapshot.heapUsedMB}/${snapshot.heapTotalMB}MB | ` +
        `RSS: ${snapshot.rssMB}MB | ` +
        `External: ${snapshot.externalMB}MB | ` +
        `Cache: ${snapshot.cacheKeys} keys | ` +
        `Requests: ${reqPerSec.toFixed(1)}/sec | ` +
        `Heap growth: ${heapGrowthPerMin > 0 ? '+' : ''}${heapGrowthPerMin}MB/min`
    );

    // Warn if memory is growing rapidly
    if (heapGrowthPerMin > 10) {
        logger.warn(
            `[MEMORY_PROFILER] WARNING: Heap growing at ${heapGrowthPerMin}MB/min! ` +
            `Total requests: ${requestCount}`
        );
    }

    // Critical warning if heap is very high
    if (snapshot.heapUsedMB > 300) {
        logger.error(
            `[MEMORY_PROFILER] CRITICAL: Heap usage at ${snapshot.heapUsedMB}MB! ` +
            `This may cause OOM soon.`
        );
    }
}

// Start profiling every 10 seconds
let intervalId: NodeJS.Timeout | null = null;

export function startMemoryProfiler() {
    if (intervalId) {
        return; // Already running
    }

    logger.info("[MEMORY_PROFILER] Starting memory profiler (10-second intervals)");
    intervalId = setInterval(logMemoryStatus, 10000);

    // Take initial snapshot immediately
    logMemoryStatus();
}

export function stopMemoryProfiler() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        logger.info("[MEMORY_PROFILER] Stopped memory profiler");
    }
}

// Export for manual heap dump trigger
export function getMemoryReport(): string {
    const snapshot = takeSnapshot();
    const recentSnapshots = snapshots.slice(-6);

    let report = "=== MEMORY REPORT ===\n";
    report += `Current Time: ${new Date().toISOString()}\n`;
    report += `Heap Used: ${snapshot.heapUsedMB}MB\n`;
    report += `Heap Total: ${snapshot.heapTotalMB}MB\n`;
    report += `RSS: ${snapshot.rssMB}MB\n`;
    report += `External: ${snapshot.externalMB}MB\n`;
    report += `Array Buffers: ${snapshot.arrayBuffersMB}MB\n`;
    report += `Cache Keys: ${snapshot.cacheKeys}\n`;
    report += `Cache Hit Rate: ${snapshot.cacheHits > 0 ? ((snapshot.cacheHits / (snapshot.cacheHits + snapshot.cacheMisses)) * 100).toFixed(2) : 0}%\n`;
    report += `Total Requests: ${requestCount}\n`;
    report += "\n=== LAST 60 SECONDS ===\n";

    recentSnapshots.forEach((s, i) => {
        const age = Math.round((Date.now() - s.timestamp) / 1000);
        report += `${age}s ago: Heap=${s.heapUsedMB}MB, Cache=${s.cacheKeys} keys\n`;
    });

    return report;
}

// Auto-start on import
startMemoryProfiler();
