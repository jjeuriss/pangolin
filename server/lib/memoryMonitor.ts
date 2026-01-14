import logger from "@server/logger";

let intervalId: NodeJS.Timeout | null = null;

/**
 * Start periodic memory monitoring
 * Logs memory usage every minute to help track memory patterns
 */
export function startMemoryMonitor(intervalMs: number = 60000): void {
    if (intervalId) {
        return; // Already running
    }

    // Log initial memory usage
    logMemoryUsage();

    intervalId = setInterval(logMemoryUsage, intervalMs);

    logger.info(
        `Memory monitor started - logging every ${intervalMs / 1000} seconds`
    );
}

/**
 * Stop memory monitoring
 */
export function stopMemoryMonitor(): void {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        logger.info("Memory monitor stopped");
    }
}

/**
 * Log current memory usage
 */
export function logMemoryUsage(): void {
    const usage = process.memoryUsage();

    logger.info(
        `Memory: RSS=${formatBytes(usage.rss)}, Heap=${formatBytes(usage.heapUsed)}/${formatBytes(usage.heapTotal)}, External=${formatBytes(usage.external)}, ArrayBuffers=${formatBytes(usage.arrayBuffers)}`
    );
}

/**
 * Get memory usage as an object (for API endpoints)
 */
export function getMemoryUsage(): {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    rssFormatted: string;
    heapUsedFormatted: string;
    heapTotalFormatted: string;
} {
    const usage = process.memoryUsage();

    return {
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
        rssFormatted: formatBytes(usage.rss),
        heapUsedFormatted: formatBytes(usage.heapUsed),
        heapTotalFormatted: formatBytes(usage.heapTotal)
    };
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)}MB`;
}
