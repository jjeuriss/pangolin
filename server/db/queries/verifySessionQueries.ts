import { db, loginPage, LoginPage, loginPageOrg, Org, orgs } from "@server/db";
import {
    Resource,
    ResourcePassword,
    ResourcePincode,
    ResourceRule,
    resourcePassword,
    resourcePincode,
    resourceHeaderAuth,
    ResourceHeaderAuth,
    resourceRules,
    resources,
    roleResources,
    sessions,
    userOrgs,
    userResources,
    users,
    ResourceHeaderAuthExtendedCompatibility,
    resourceHeaderAuthExtendedCompatibility
} from "@server/db";
import { and, eq } from "drizzle-orm";
import { isFeatureDisabled } from "@server/lib/featureFlags";
import logger from "@server/logger";

export type ResourceWithAuth = {
    resource: Resource | null;
    pincode: ResourcePincode | null;
    password: ResourcePassword | null;
    headerAuth: ResourceHeaderAuth | null;
    headerAuthExtendedCompatibility: ResourceHeaderAuthExtendedCompatibility | null;
    org: Org;
};

export type UserSessionWithUser = {
    session: any;
    user: any;
};

/**
 * Get resource by domain with pincode and password information
 */
export async function getResourceByDomain(
    domain: string
): Promise<ResourceWithAuth | null> {
    // DISK_IO_INVESTIGATION: Skip all session queries when flag is set
    if (isFeatureDisabled("DISABLE_SESSION_QUERIES")) {
        logger.debug(`[DISK_IO_INVESTIGATION] Skipping getResourceByDomain for domain=${domain} - DISABLE_SESSION_QUERIES=true`);
        return null;
    }

    logger.debug(`[DB_QUERY] getResourceByDomain START - domain=${domain}`);
    const startTime = performance.now();

    const [result] = await db
        .select()
        .from(resources)
        .leftJoin(
            resourcePincode,
            eq(resourcePincode.resourceId, resources.resourceId)
        )
        .leftJoin(
            resourcePassword,
            eq(resourcePassword.resourceId, resources.resourceId)
        )
        .leftJoin(
            resourceHeaderAuth,
            eq(resourceHeaderAuth.resourceId, resources.resourceId)
        )
        .leftJoin(
            resourceHeaderAuthExtendedCompatibility,
            eq(
                resourceHeaderAuthExtendedCompatibility.resourceId,
                resources.resourceId
            )
        )
        .innerJoin(orgs, eq(orgs.orgId, resources.orgId))
        .where(eq(resources.fullDomain, domain))
        .limit(1);

    const duration = performance.now() - startTime;
    logger.debug(`[DB_QUERY] getResourceByDomain END - domain=${domain}, duration=${duration.toFixed(2)}ms, found=${!!result}`);

    if (!result) {
        return null;
    }

    return {
        resource: result.resources,
        pincode: result.resourcePincode,
        password: result.resourcePassword,
        headerAuth: result.resourceHeaderAuth,
        headerAuthExtendedCompatibility:
            result.resourceHeaderAuthExtendedCompatibility,
        org: result.orgs
    };
}

/**
 * Get user session with user information
 */
export async function getUserSessionWithUser(
    userSessionId: string
): Promise<UserSessionWithUser | null> {
    if (isFeatureDisabled("DISABLE_SESSION_QUERIES")) {
        return null;
    }

    logger.debug(`[DB_QUERY] getUserSessionWithUser START - sessionId=${userSessionId}`);
    const startTime = performance.now();

    const [res] = await db
        .select()
        .from(sessions)
        .leftJoin(users, eq(users.userId, sessions.userId))
        .where(eq(sessions.sessionId, userSessionId));

    const duration = performance.now() - startTime;
    logger.debug(`[DB_QUERY] getUserSessionWithUser END - sessionId=${userSessionId}, duration=${duration.toFixed(2)}ms, found=${!!res}`);

    if (!res) {
        return null;
    }

    return {
        session: res.session,
        user: res.user
    };
}

/**
 * Get user organization role
 */
export async function getUserOrgRole(userId: string, orgId: string) {
    if (isFeatureDisabled("DISABLE_SESSION_QUERIES")) {
        return null;
    }

    logger.debug(`[DB_QUERY] getUserOrgRole START - userId=${userId}, orgId=${orgId}`);
    const startTime = performance.now();

    const userOrgRole = await db
        .select()
        .from(userOrgs)
        .where(and(eq(userOrgs.userId, userId), eq(userOrgs.orgId, orgId)))
        .limit(1);

    const duration = performance.now() - startTime;
    logger.debug(`[DB_QUERY] getUserOrgRole END - userId=${userId}, orgId=${orgId}, duration=${duration.toFixed(2)}ms, found=${userOrgRole.length > 0}`);

    return userOrgRole.length > 0 ? userOrgRole[0] : null;
}

/**
 * Check if role has access to resource
 */
export async function getRoleResourceAccess(
    resourceId: number,
    roleId: number
) {
    if (isFeatureDisabled("DISABLE_SESSION_QUERIES")) {
        return null;
    }

    logger.debug(`[DB_QUERY] getRoleResourceAccess START - resourceId=${resourceId}, roleId=${roleId}`);
    const startTime = performance.now();

    const roleResourceAccess = await db
        .select()
        .from(roleResources)
        .where(
            and(
                eq(roleResources.resourceId, resourceId),
                eq(roleResources.roleId, roleId)
            )
        )
        .limit(1);

    const duration = performance.now() - startTime;
    logger.debug(`[DB_QUERY] getRoleResourceAccess END - resourceId=${resourceId}, roleId=${roleId}, duration=${duration.toFixed(2)}ms, found=${roleResourceAccess.length > 0}`);

    return roleResourceAccess.length > 0 ? roleResourceAccess[0] : null;
}

/**
 * Check if user has direct access to resource
 */
export async function getUserResourceAccess(
    userId: string,
    resourceId: number
) {
    if (isFeatureDisabled("DISABLE_SESSION_QUERIES")) {
        return null;
    }

    logger.debug(`[DB_QUERY] getUserResourceAccess START - userId=${userId}, resourceId=${resourceId}`);
    const startTime = performance.now();

    const userResourceAccess = await db
        .select()
        .from(userResources)
        .where(
            and(
                eq(userResources.userId, userId),
                eq(userResources.resourceId, resourceId)
            )
        )
        .limit(1);

    const duration = performance.now() - startTime;
    logger.debug(`[DB_QUERY] getUserResourceAccess END - userId=${userId}, resourceId=${resourceId}, duration=${duration.toFixed(2)}ms, found=${userResourceAccess.length > 0}`);

    return userResourceAccess.length > 0 ? userResourceAccess[0] : null;
}

/**
 * Get resource rules for a given resource
 */
export async function getResourceRules(
    resourceId: number
): Promise<ResourceRule[]> {
    if (isFeatureDisabled("DISABLE_SESSION_QUERIES")) {
        return [];
    }

    logger.debug(`[DB_QUERY] getResourceRules START - resourceId=${resourceId}`);
    const startTime = performance.now();

    const rules = await db
        .select()
        .from(resourceRules)
        .where(eq(resourceRules.resourceId, resourceId));

    const duration = performance.now() - startTime;
    logger.debug(`[DB_QUERY] getResourceRules END - resourceId=${resourceId}, duration=${duration.toFixed(2)}ms, rulesCount=${rules.length}`);

    return rules;
}

/**
 * Get organization login page
 */
export async function getOrgLoginPage(
    orgId: string
): Promise<LoginPage | null> {
    if (isFeatureDisabled("DISABLE_SESSION_QUERIES")) {
        return null;
    }

    logger.debug(`[DB_QUERY] getOrgLoginPage START - orgId=${orgId}`);
    const startTime = performance.now();

    const [result] = await db
        .select()
        .from(loginPageOrg)
        .where(eq(loginPageOrg.orgId, orgId))
        .innerJoin(
            loginPage,
            eq(loginPageOrg.loginPageId, loginPage.loginPageId)
        )
        .limit(1);

    const duration = performance.now() - startTime;
    logger.debug(`[DB_QUERY] getOrgLoginPage END - orgId=${orgId}, duration=${duration.toFixed(2)}ms, found=${!!result}`);

    if (!result) {
        return null;
    }

    return result?.loginPage;
}
