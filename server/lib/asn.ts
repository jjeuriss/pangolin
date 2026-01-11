import logger from "@server/logger";
import { maxmindAsnLookup } from "@server/db/maxmindAsn";
import { isFeatureDisabled } from "@server/lib/featureFlags";

export async function getAsnForIp(ip: string): Promise<number | undefined> {
    // DISK_IO_INVESTIGATION: Skip ASN lookup when flag is set
    if (isFeatureDisabled("DISABLE_ASN_LOOKUP")) {
        return undefined;
    }

    try {
        if (!maxmindAsnLookup) {
            logger.debug(
                "MaxMind ASN DB path not configured, cannot perform ASN lookup"
            );
            return;
        }

        const result = maxmindAsnLookup.get(ip);

        if (!result || !result.autonomous_system_number) {
            return;
        }

        logger.debug(
            `ASN lookup successful for IP ${ip}: AS${result.autonomous_system_number}`
        );

        return result.autonomous_system_number;
    } catch (error) {
        logger.error("Error performing ASN lookup:", error);
    }

    return;
}
