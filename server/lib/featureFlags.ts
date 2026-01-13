/**
 * Feature flags for disk I/O investigation
 *
 * These flags allow us to systematically disable features to identify
 * which one is causing excessive disk I/O on high volume unauthenticated requests.
 *
 * Set environment variables to 'true' to DISABLE each feature for testing.
 *
 * Usage:
 *   docker run -e DISABLE_AUDIT_LOGGING=true ...
 *   DISABLE_AUDIT_LOGGING=true npm run dev
 */

import logger from "@server/logger";

export const diskIOInvestigationFlags = {
    // Phase 1: High Suspicion
    DISABLE_AUDIT_LOGGING:
        process.env.DISABLE_AUDIT_LOGGING === "true",
    DISABLE_SESSION_QUERIES:
        process.env.DISABLE_SESSION_QUERIES === "true",
    DISABLE_LOG_ANALYTICS:
        process.env.DISABLE_LOG_ANALYTICS === "true",
    DISABLE_GEOIP_LOOKUP:
        process.env.DISABLE_GEOIP_LOOKUP === "true",
    DISABLE_ASN_LOOKUP:
        process.env.DISABLE_ASN_LOOKUP === "true",
    DISABLE_ORG_ACCESS_POLICY:
        process.env.DISABLE_ORG_ACCESS_POLICY === "true",

    // Phase 2: Medium Suspicion
    DISABLE_LOG_CLEANUP:
        process.env.DISABLE_LOG_CLEANUP === "true",
    DISABLE_RULES_CHECK:
        process.env.DISABLE_RULES_CHECK === "true"
};

// Log which flags are enabled on startup
const enabledFlags = Object.entries(diskIOInvestigationFlags)
    .filter(([_, value]) => value)
    .map(([key]) => key);

if (enabledFlags.length > 0) {
    logger.warn(
        `[DISK_IO_INVESTIGATION] Features disabled: ${enabledFlags.join(", ")}`
    );
}

export function isFeatureDisabled(
    flagName: keyof typeof diskIOInvestigationFlags
): boolean {
    return diskIOInvestigationFlags[flagName];
}
