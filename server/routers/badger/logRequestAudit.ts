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
const MAX_BUFFER_SIZE = 500; // Absolute maximum to prevent memory issues
let flushTimer: NodeJS.Timeout | null = null;
let droppedLogCount = 0; // Track total dropped logs for monitoring

/**
 * Flush buffered logs to database
 */
async function flushAuditLogs() {
    if (auditLogBuffer.length === 0) {
        return;
    }

    // Take all current logs and clear buffer
    const logsToWrite = auditLogBuffer.splice(0, auditLogBuffer.length);

    try {
        // Batch insert all logs at once
        await db.insert(requestAuditLog).values(logsToWrite);
        logger.debug(`Flushed ${logsToWrite.length} audit logs to database`);
    } catch (error) {
        logger.error("Error flushing audit logs:", error);
        // On error, we lose these logs - consider a fallback strategy if needed
        // (e.g., write to file, or put back in buffer with retry limit)
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

        // Prevent unbounded buffer growth - drop oldest entries if at max
        if (auditLogBuffer.length >= MAX_BUFFER_SIZE) {
            const dropped = auditLogBuffer.splice(
                0,
                auditLogBuffer.length - BATCH_SIZE
            );
            droppedLogCount += dropped.length;
            logger.warn(
                `Audit log buffer overflow - dropped ${dropped.length} entries (${droppedLogCount} total dropped)`
            );
        }

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

        // Flush immediately if buffer is full, otherwise schedule a flush
        if (auditLogBuffer.length >= BATCH_SIZE) {
            // Fire and forget - don't block the caller
            flushAuditLogs().catch((err) =>
                logger.error("Error flushing audit logs:", err)
            );
        } else {
            scheduleFlush();
        }
    } catch (error) {
        logger.error(error);
    }
}
