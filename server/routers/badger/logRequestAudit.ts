import { db, orgs, requestAuditLog } from "@server/db";
import logger from "@server/logger";
import { and, eq, lt } from "drizzle-orm";
import cache from "@server/lib/cache";
import { calculateCutoffTimestamp } from "@server/lib/cleanupLogs";
import { stripPortFromHost } from "@server/lib/ip";

/**

Reasons:
100 - Allowed by Rule
101 - Allowed No Auth
102 - Valid Access Token
103 - Valid Header Auth (HTTP Basic Auth)
104 - Valid Pincode
105 - Valid Password
106 - Valid email
107 - Valid SSO

201 - Resource Not Found
202 - Resource Blocked
203 - Dropped by Rule
204 - No Sessions
205 - Temporary Request Token
299 - No More Auth Methods

 */

// In-memory buffer for batching audit logs
const auditLogBuffer: Array<{
    timestamp: number;
    orgId?: string;
    actorType?: string;
    actor?: string;
    actorId?: string;
    metadata: any;
    action: boolean;
    resourceId?: number;
    reason: number;
    location?: string;
    originalRequestURL: string;
    scheme: string;
    host: string;
    path: string;
    method: string;
    ip?: string;
    tls: boolean;
}> = [];

const BATCH_SIZE = 100; // Write to DB every 100 logs
const BATCH_INTERVAL_MS = 5000; // Or every 5 seconds, whichever comes first
const MAX_BUFFER_SIZE = 500; // Safety valve - force flush if buffer exceeds this
let flushTimer: NodeJS.Timeout | null = null;

// Track failed flush attempts for monitoring
let failedFlushCount = 0;

// Buffer monitoring - logs buffer size every 30 seconds
let monitoringInterval: NodeJS.Timeout | null = null;
monitoringInterval = setInterval(() => {
    const bufferSize = auditLogBuffer.length;
    const estimatedMemoryKB = Math.round(bufferSize * 1.5);
    // Always log to confirm monitoring is active (even when buffer is 0)
    logger.debug(
        `Audit buffer: ${bufferSize} items, ~${estimatedMemoryKB}KB, Heap: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
    );
    
    // Safety valve: if buffer is too large, force flush
    if (bufferSize > MAX_BUFFER_SIZE) {
        logger.warn(`Audit buffer exceeded ${MAX_BUFFER_SIZE} items! Force flushing...`);
        flushAuditLogs().catch((err) =>
            logger.error("Error in force flush:", err)
        );
    }
}, 30000);

/**
 * Flush buffered logs to database with retry logic
 */
async function flushAuditLogs(retryCount = 0, maxRetries = 3) {
    if (auditLogBuffer.length === 0) {
        return;
    }

    // Take all current logs and clear buffer
    const logsToWrite = auditLogBuffer.splice(0, auditLogBuffer.length);
    const logCount = logsToWrite.length;

    try {
        // Batch insert all logs at once
        await db.insert(requestAuditLog).values(logsToWrite);
        logger.debug(`Flushed ${logCount} audit logs to database`);
        
        // Reset failed flush counter on success
        if (failedFlushCount > 0) {
            logger.info(`Audit log flushing recovered after ${failedFlushCount} failed attempts`);
            failedFlushCount = 0;
        }
    } catch (error) {
        logger.error("Error flushing audit logs:", error);
        failedFlushCount++;
        
        // Retry with exponential backoff if we haven't exceeded max retries
        if (retryCount < maxRetries) {
            const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30s backoff
            logger.warn(`Retrying audit log flush in ${backoffMs}ms (attempt ${retryCount + 1}/${maxRetries})`);
            
            // Put logs back in buffer for retry
            auditLogBuffer.unshift(...logsToWrite);
            
            // Retry after delay
            setTimeout(() => {
                flushAuditLogs(retryCount + 1, maxRetries).catch((err) => 
                    logger.error("Error in audit log flush retry:", err)
                );
            }, backoffMs);
        } else {
            logger.error(`Failed to flush ${logCount} audit logs after ${maxRetries} retries - logs are lost`);
            logger.warn(`Total failed flush attempts: ${failedFlushCount}`);
        }
    } finally {
        // Explicitly clear the array to help garbage collection
        logsToWrite.length = 0;
    }
}

/**
 * Schedule a flush if not already scheduled
 */
function scheduleFlush() {
    if (flushTimer === null) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushAuditLogs().catch((err) =>
                logger.error("Error in scheduled flush:", err)
            );
        }, BATCH_INTERVAL_MS);
    }
}

/**
 * Gracefully flush all pending logs (call this on shutdown)
 */
export async function shutdownAuditLogger() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    await flushAuditLogs();
}

async function getRetentionDays(orgId: string): Promise<number> {
    // check cache first
    const cached = cache.get<number>(`org_${orgId}_retentionDays`);
    if (cached !== undefined) {
        return cached;
    }

    const [org] = await db
        .select({
            settingsLogRetentionDaysRequest:
                orgs.settingsLogRetentionDaysRequest
        })
        .from(orgs)
        .where(eq(orgs.orgId, orgId))
        .limit(1);

    if (!org) {
        return 0;
    }

    // store the result in cache
    cache.set(
        `org_${orgId}_retentionDays`,
        org.settingsLogRetentionDaysRequest,
        300
    );

    return org.settingsLogRetentionDaysRequest;
}

export async function cleanUpOldLogs(orgId: string, retentionDays: number) {
    const cutoffTimestamp = calculateCutoffTimestamp(retentionDays);

    try {
        await db
            .delete(requestAuditLog)
            .where(
                and(
                    lt(requestAuditLog.timestamp, cutoffTimestamp),
                    eq(requestAuditLog.orgId, orgId)
                )
            );

        // logger.debug(
        //     `Cleaned up request audit logs older than ${retentionDays} days`
        // );
    } catch (error) {
        logger.error("Error cleaning up old request audit logs:", error);
    }
}

export async function logRequestAudit(
    data: {
        action: boolean;
        reason: number;
        resourceId?: number;
        orgId?: string;
        location?: string;
        user?: { username: string; userId: string };
        apiKey?: { name: string | null; apiKeyId: string };
        metadata?: any;
        // userAgent?: string;
    },
    body: {
        path: string;
        originalRequestURL: string;
        scheme: string;
        host: string;
        method: string;
        tls: boolean;
        sessions?: Record<string, string>;
        headers?: Record<string, string>;
        query?: Record<string, string>;
        requestIp?: string;
    }
) {
    try {
        // TEMPORARILY DISABLED FOR DISK I/O TESTING
        // This disables all request audit logging to test if writes are causing the I/O issue
        logger.debug("[REQUEST_AUDIT] Logging temporarily disabled for disk I/O testing");
        return;

        /* eslint-disable no-unreachable */
        // Check retention before buffering any logs
        if (data.orgId) {
            const retentionDays = await getRetentionDays(data.orgId);
            if (retentionDays === 0) {
                // do not log
                return;
            }
        }

        let actorType: string | undefined;
        let actor: string | undefined;
        let actorId: string | undefined;

        const user = data.user;
        if (user) {
            actorType = "user";
            actor = user.username;
            actorId = user.userId;
        }
        const apiKey = data.apiKey;
        if (apiKey) {
            actorType = "apiKey";
            actor = apiKey.name || apiKey.apiKeyId;
            actorId = apiKey.apiKeyId;
        }

        const timestamp = Math.floor(Date.now() / 1000);

        let metadata = null;
        if (data.metadata) {
            metadata = JSON.stringify(data.metadata);
        }

        const clientIp = body.requestIp
            ? stripPortFromHost(body.requestIp)
            : undefined;

        // Add to buffer instead of writing directly to DB
        auditLogBuffer.push({
            timestamp,
            orgId: data.orgId,
            actorType,
            actor,
            actorId,
            metadata,
            action: data.action,
            resourceId: data.resourceId,
            reason: data.reason,
            location: data.location,
            originalRequestURL: body.originalRequestURL,
            scheme: body.scheme,
            host: body.host,
            path: body.path,
            method: body.method,
            ip: clientIp,
            tls: body.tls
        });

        // Check if we should flush based on buffer size
        if (auditLogBuffer.length >= BATCH_SIZE) {
            // Flush immediately if buffer is full (batched write)
            flushAuditLogs().catch((err) =>
                logger.error("Error flushing audit logs:", err)
            );
        } else {
            // Normal case - schedule a flush after BATCH_INTERVAL_MS
            scheduleFlush();
        }
        /* eslint-enable no-unreachable */
    } catch (error) {
        logger.error(error);
    }
}
