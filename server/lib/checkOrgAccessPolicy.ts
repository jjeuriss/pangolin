import { Org, ResourceSession, Session, User } from "@server/db";
import { isFeatureDisabled } from "@server/lib/featureFlags";

export type CheckOrgAccessPolicyProps = {
    orgId?: string;
    org?: Org;
    userId?: string;
    user?: User;
    sessionId?: string;
    session?: Session;
};

export type CheckOrgAccessPolicyResult = {
    allowed: boolean;
    error?: string;
    policies?: {
        requiredTwoFactor?: boolean;
        maxSessionLength?: {
            compliant: boolean;
            maxSessionLengthHours: number;
            sessionAgeHours: number;
        };
        passwordAge?: {
            compliant: boolean;
            maxPasswordAgeDays: number;
            passwordAgeDays: number;
        };
    };
};

export async function enforceResourceSessionLength(
    resourceSession: ResourceSession,
    org: Org
): Promise<{ valid: boolean; error?: string }> {
    return { valid: true };
}

export async function checkOrgAccessPolicy(
    props: CheckOrgAccessPolicyProps
): Promise<CheckOrgAccessPolicyResult> {
    // DISK_IO_INVESTIGATION: Skip org access policy check when flag is set
    if (isFeatureDisabled("DISABLE_ORG_ACCESS_POLICY")) {
        return { allowed: true };
    }

    return { allowed: true };
}
