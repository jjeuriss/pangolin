import { db, orgs } from "@server/db";
import { cleanUpOldLogs as cleanUpOldAccessLogs } from "#dynamic/lib/logAccessAudit";
import { cleanUpOldLogs as cleanUpOldActionLogs } from "#dynamic/middlewares/logActionAudit";
import { cleanUpOldLogs as cleanUpOldRequestLogs } from "@server/routers/badger/logRequestAudit";
import { gt, or } from "drizzle-orm";
import logger from "@server/logger";

export function initLogCleanupInterval() {
    logger.debug(`[LOG_CLEANUP] Initializing log cleanup interval (every 3 hours)`);
    return setInterval(
        async () => {
            const cleanupStartTime = performance.now();
            logger.debug(`[LOG_CLEANUP] ===== LOG CLEANUP STARTED =====`);

            logger.debug(`[LOG_CLEANUP] Querying orgs with retention policies`);
            const queryStartTime = performance.now();
            const orgsToClean = await db
                .select({
                    orgId: orgs.orgId,
                    settingsLogRetentionDaysAction:
                        orgs.settingsLogRetentionDaysAction,
                    settingsLogRetentionDaysAccess:
                        orgs.settingsLogRetentionDaysAccess,
                    settingsLogRetentionDaysRequest:
                        orgs.settingsLogRetentionDaysRequest
                })
                .from(orgs)
                .where(
                    or(
                        gt(orgs.settingsLogRetentionDaysAction, 0),
                        gt(orgs.settingsLogRetentionDaysAccess, 0),
                        gt(orgs.settingsLogRetentionDaysRequest, 0)
                    )
                );
            const queryDuration = performance.now() - queryStartTime;
            logger.debug(`[LOG_CLEANUP] Found ${orgsToClean.length} orgs to clean, query took ${queryDuration.toFixed(2)}ms`);

            for (const org of orgsToClean) {
                const {
                    orgId,
                    settingsLogRetentionDaysAction,
                    settingsLogRetentionDaysAccess,
                    settingsLogRetentionDaysRequest
                } = org;

                logger.debug(`[LOG_CLEANUP] Cleaning logs for orgId=${orgId}, retentionDays: action=${settingsLogRetentionDaysAction}, access=${settingsLogRetentionDaysAccess}, request=${settingsLogRetentionDaysRequest}`);

                if (settingsLogRetentionDaysAction > 0) {
                    const actionStartTime = performance.now();
                    logger.debug(`[LOG_CLEANUP] Cleaning action logs for orgId=${orgId}, retentionDays=${settingsLogRetentionDaysAction}`);
                    await cleanUpOldActionLogs(
                        orgId,
                        settingsLogRetentionDaysAction
                    );
                    const actionDuration = performance.now() - actionStartTime;
                    logger.debug(`[LOG_CLEANUP] Cleaned action logs for orgId=${orgId}, took ${actionDuration.toFixed(2)}ms`);
                }

                if (settingsLogRetentionDaysAccess > 0) {
                    const accessStartTime = performance.now();
                    logger.debug(`[LOG_CLEANUP] Cleaning access logs for orgId=${orgId}, retentionDays=${settingsLogRetentionDaysAccess}`);
                    await cleanUpOldAccessLogs(
                        orgId,
                        settingsLogRetentionDaysAccess
                    );
                    const accessDuration = performance.now() - accessStartTime;
                    logger.debug(`[LOG_CLEANUP] Cleaned access logs for orgId=${orgId}, took ${accessDuration.toFixed(2)}ms`);
                }

                if (settingsLogRetentionDaysRequest > 0) {
                    const requestStartTime = performance.now();
                    logger.debug(`[LOG_CLEANUP] Cleaning request logs for orgId=${orgId}, retentionDays=${settingsLogRetentionDaysRequest}`);
                    await cleanUpOldRequestLogs(
                        orgId,
                        settingsLogRetentionDaysRequest
                    );
                    const requestDuration = performance.now() - requestStartTime;
                    logger.debug(`[LOG_CLEANUP] Cleaned request logs for orgId=${orgId}, took ${requestDuration.toFixed(2)}ms`);
                }
            }

            const cleanupDuration = performance.now() - cleanupStartTime;
            logger.debug(`[LOG_CLEANUP] ===== LOG CLEANUP COMPLETED ===== Total duration: ${cleanupDuration.toFixed(2)}ms`);
        },
        3 * 60 * 60 * 1000
    ); // every 3 hours
}

export function calculateCutoffTimestamp(retentionDays: number): number {
    const now = Math.floor(Date.now() / 1000);
    if (retentionDays === 9001) {
        // Special case: data is erased at the end of the year following the year it was generated
        // This means we delete logs from 2 years ago or older (logs from year Y are deleted after Dec 31 of year Y+1)
        const currentYear = new Date().getFullYear();
        // Cutoff is the start of the year before last (Jan 1, currentYear - 1 at 00:00:00)
        // Any logs before this date are from 2+ years ago and should be deleted
        const cutoffDate = new Date(Date.UTC(currentYear - 1, 0, 1, 0, 0, 0));
        return Math.floor(cutoffDate.getTime() / 1000);
    } else {
        return now - retentionDays * 24 * 60 * 60;
    }
}
