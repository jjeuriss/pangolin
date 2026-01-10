import { db, primaryDb, requestAuditLog, resources } from "@server/db";
import { registry } from "@server/openApi";
import { NextFunction } from "express";
import { Request, Response } from "express";
import { eq, gt, lt, and, count, desc } from "drizzle-orm";
import { OpenAPITags } from "@server/openApi";
import { z } from "zod";
import createHttpError from "http-errors";
import HttpCode from "@server/types/HttpCode";
import { fromError } from "zod-validation-error";
import { QueryRequestAuditLogResponse } from "@server/routers/auditLogs/types";
import response from "@server/lib/response";
import logger from "@server/logger";
import { getSevenDaysAgo } from "@app/lib/getSevenDaysAgo";
import cache from "@server/lib/cache";

// Cache hit rate monitoring - logs summary every 5 minutes to avoid spam
let cacheHits = 0;
let cacheMisses = 0;
let lastStatsLogTime = Date.now();

function logCacheStats() {
    const now = Date.now();
    const timeSinceLastLog = now - lastStatsLogTime;

    // Log stats every 5 minutes (300000ms)
    if (timeSinceLastLog >= 300000 && (cacheHits > 0 || cacheMisses > 0)) {
        const total = cacheHits + cacheMisses;
        const hitRate = total > 0 ? ((cacheHits / total) * 100).toFixed(1) : "0.0";
        logger.info(`[FILTER_ATTRS] Cache stats: ${cacheHits} hits, ${cacheMisses} misses (${hitRate}% hit rate) over ${Math.round(timeSinceLastLog / 60000)} minutes`);

        // Reset counters
        cacheHits = 0;
        cacheMisses = 0;
        lastStatsLogTime = now;
    }
}

export const queryAccessAuditLogsQuery = z.object({
    // iso string just validate its a parseable date
    timeStart: z
        .string()
        .refine((val) => !isNaN(Date.parse(val)), {
            error: "timeStart must be a valid ISO date string"
        })
        .transform((val) => Math.floor(new Date(val).getTime() / 1000))
        .prefault(() => getSevenDaysAgo().toISOString())
        .openapi({
            type: "string",
            format: "date-time",
            description:
                "Start time as ISO date string (defaults to 7 days ago)"
        }),
    timeEnd: z
        .string()
        .refine((val) => !isNaN(Date.parse(val)), {
            error: "timeEnd must be a valid ISO date string"
        })
        .transform((val) => Math.floor(new Date(val).getTime() / 1000))
        .optional()
        .prefault(() => new Date().toISOString())
        .openapi({
            type: "string",
            format: "date-time",
            description:
                "End time as ISO date string (defaults to current time)"
        }),
    action: z
        .union([z.boolean(), z.string()])
        .transform((val) => (typeof val === "string" ? val === "true" : val))
        .optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
    reason: z
        .string()
        .optional()
        .transform(Number)
        .pipe(z.int().positive())
        .optional(),
    resourceId: z
        .string()
        .optional()
        .transform(Number)
        .pipe(z.int().positive())
        .optional(),
    actor: z.string().optional(),
    location: z.string().optional(),
    host: z.string().optional(),
    path: z.string().optional(),
    limit: z
        .string()
        .optional()
        .default("1000")
        .transform(Number)
        .pipe(z.int().positive()),
    offset: z
        .string()
        .optional()
        .default("0")
        .transform(Number)
        .pipe(z.int().nonnegative())
});

export const queryRequestAuditLogsParams = z.object({
    orgId: z.string()
});

export const queryRequestAuditLogsCombined = queryAccessAuditLogsQuery.merge(
    queryRequestAuditLogsParams
);
type Q = z.infer<typeof queryRequestAuditLogsCombined>;

function getWhere(data: Q) {
    return and(
        gt(requestAuditLog.timestamp, data.timeStart),
        lt(requestAuditLog.timestamp, data.timeEnd),
        eq(requestAuditLog.orgId, data.orgId),
        data.resourceId
            ? eq(requestAuditLog.resourceId, data.resourceId)
            : undefined,
        data.actor ? eq(requestAuditLog.actor, data.actor) : undefined,
        data.method ? eq(requestAuditLog.method, data.method) : undefined,
        data.reason ? eq(requestAuditLog.reason, data.reason) : undefined,
        data.host ? eq(requestAuditLog.host, data.host) : undefined,
        data.location ? eq(requestAuditLog.location, data.location) : undefined,
        data.path ? eq(requestAuditLog.path, data.path) : undefined,
        data.action !== undefined
            ? eq(requestAuditLog.action, data.action)
            : undefined
    );
}

export function queryRequest(data: Q) {
    return primaryDb
        .select({
            id: requestAuditLog.id,
            timestamp: requestAuditLog.timestamp,
            orgId: requestAuditLog.orgId,
            action: requestAuditLog.action,
            reason: requestAuditLog.reason,
            actorType: requestAuditLog.actorType,
            actor: requestAuditLog.actor,
            actorId: requestAuditLog.actorId,
            resourceId: requestAuditLog.resourceId,
            ip: requestAuditLog.ip,
            location: requestAuditLog.location,
            userAgent: requestAuditLog.userAgent,
            metadata: requestAuditLog.metadata,
            headers: requestAuditLog.headers,
            query: requestAuditLog.query,
            originalRequestURL: requestAuditLog.originalRequestURL,
            scheme: requestAuditLog.scheme,
            host: requestAuditLog.host,
            path: requestAuditLog.path,
            method: requestAuditLog.method,
            tls: requestAuditLog.tls,
            resourceName: resources.name,
            resourceNiceId: resources.niceId
        })
        .from(requestAuditLog)
        .leftJoin(
            resources,
            eq(requestAuditLog.resourceId, resources.resourceId)
        ) // TODO: Is this efficient?
        .where(getWhere(data))
        .orderBy(desc(requestAuditLog.timestamp));
}

export function countRequestQuery(data: Q) {
    const countQuery = primaryDb
        .select({ count: count() })
        .from(requestAuditLog)
        .where(getWhere(data));
    return countQuery;
}

registry.registerPath({
    method: "get",
    path: "/org/{orgId}/logs/request",
    description: "Query the request audit log for an organization",
    tags: [OpenAPITags.Org],
    request: {
        query: queryAccessAuditLogsQuery,
        params: queryRequestAuditLogsParams
    },
    responses: {}
});

async function queryUniqueFilterAttributes(
    timeStart: number,
    timeEnd: number,
    orgId: string
) {
    // Cache key includes orgId and rounded time range (15-minute buckets) to reduce cache misses
    // while still providing reasonable freshness for filter attributes
    const roundedStart = Math.floor(timeStart / 900) * 900; // Round to 15-minute intervals
    const roundedEnd = Math.floor(timeEnd / 900) * 900;
    const cacheKey = `filterAttrs:${orgId}:${roundedStart}:${roundedEnd}`;

    // Check cache first - these queries are EXTREMELY expensive (full table scans with DISTINCT)
    const cached = cache.get<{
        actors: string[];
        resources: { id: number; name: string | null }[];
        locations: string[];
        hosts: string[];
        paths: string[];
    }>(cacheKey);
    if (cached !== undefined) {
        cacheHits++;
        logCacheStats();
        logger.debug(`[FILTER_ATTRS] Cache HIT for ${cacheKey} - avoiding 5 expensive DISTINCT queries`);
        return cached;
    }

    cacheMisses++;
    logCacheStats();
    logger.debug(`[FILTER_ATTRS] Cache MISS for ${cacheKey} - running expensive DISTINCT queries`);

    const baseConditions = and(
        gt(requestAuditLog.timestamp, timeStart),
        lt(requestAuditLog.timestamp, timeEnd),
        eq(requestAuditLog.orgId, orgId)
    );

    const DISTINCT_LIMIT = 500;

    // TODO: SOMEONE PLEASE OPTIMIZE THIS!!!!!
    // NOTE: These 5 DISTINCT queries cause massive disk I/O on large audit log tables
    // Each one requires a full table scan to find unique values
    // With millions of rows from failed auth attempts, this was causing 13.6GB of read I/O

    // Run all queries in parallel
    const [
        uniqueActors,
        uniqueLocations,
        uniqueHosts,
        uniquePaths,
        uniqueResources
    ] = await Promise.all([
        primaryDb
            .selectDistinct({ actor: requestAuditLog.actor })
            .from(requestAuditLog)
            .where(baseConditions)
            .limit(DISTINCT_LIMIT + 1),
        primaryDb
            .selectDistinct({ locations: requestAuditLog.location })
            .from(requestAuditLog)
            .where(baseConditions)
            .limit(DISTINCT_LIMIT + 1),
        primaryDb
            .selectDistinct({ hosts: requestAuditLog.host })
            .from(requestAuditLog)
            .where(baseConditions)
            .limit(DISTINCT_LIMIT + 1),
        primaryDb
            .selectDistinct({ paths: requestAuditLog.path })
            .from(requestAuditLog)
            .where(baseConditions)
            .limit(DISTINCT_LIMIT + 1),
        primaryDb
            .selectDistinct({
                id: requestAuditLog.resourceId,
                name: resources.name
            })
            .from(requestAuditLog)
            .leftJoin(
                resources,
                eq(requestAuditLog.resourceId, resources.resourceId)
            )
            .where(baseConditions)
            .limit(DISTINCT_LIMIT + 1)
    ]);

    // TODO: for stuff like the paths this is too restrictive so lets just show some of the paths and the user needs to
    // refine the time range to see what they need to see
    // if (
    //     uniqueActors.length > DISTINCT_LIMIT ||
    //     uniqueLocations.length > DISTINCT_LIMIT ||
    //     uniqueHosts.length > DISTINCT_LIMIT ||
    //     uniquePaths.length > DISTINCT_LIMIT ||
    //     uniqueResources.length > DISTINCT_LIMIT
    // ) {
    //     throw new Error("Too many distinct filter attributes to retrieve. Please refine your time range.");
    // }

    const result = {
        actors: uniqueActors
            .map((row) => row.actor)
            .filter((actor): actor is string => actor !== null),
        resources: uniqueResources.filter(
            (row): row is { id: number; name: string | null } => row.id !== null
        ),
        locations: uniqueLocations
            .map((row) => row.locations)
            .filter((location): location is string => location !== null),
        hosts: uniqueHosts
            .map((row) => row.hosts)
            .filter((host): host is string => host !== null),
        paths: uniquePaths
            .map((row) => row.paths)
            .filter((path): path is string => path !== null)
    };

    // Cache for 15 minutes - this dramatically reduces disk I/O from repeated queries
    // Trade-off: Filter dropdowns may be up to 15 minutes stale, but this is acceptable
    // given the massive performance improvement (avoiding 5 full table scans per page load)
    cache.set(cacheKey, result, 900);
    logger.debug(`[FILTER_ATTRS] Cached result for ${cacheKey} (900s TTL)`);

    return result;
}

export async function queryRequestAuditLogs(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<any> {
    try {
        const parsedQuery = queryAccessAuditLogsQuery.safeParse(req.query);
        if (!parsedQuery.success) {
            return next(
                createHttpError(
                    HttpCode.BAD_REQUEST,
                    fromError(parsedQuery.error)
                )
            );
        }

        const parsedParams = queryRequestAuditLogsParams.safeParse(req.params);
        if (!parsedParams.success) {
            return next(
                createHttpError(
                    HttpCode.BAD_REQUEST,
                    fromError(parsedParams.error)
                )
            );
        }

        const data = { ...parsedQuery.data, ...parsedParams.data };

        const baseQuery = queryRequest(data);

        const log = await baseQuery.limit(data.limit).offset(data.offset);

        const totalCountResult = await countRequestQuery(data);
        const totalCount = totalCountResult[0].count;

        const filterAttributes = await queryUniqueFilterAttributes(
            data.timeStart,
            data.timeEnd,
            data.orgId
        );

        return response<QueryRequestAuditLogResponse>(res, {
            data: {
                log: log,
                pagination: {
                    total: totalCount,
                    limit: data.limit,
                    offset: data.offset
                },
                filterAttributes
            },
            success: true,
            error: false,
            message: "Request audit logs retrieved successfully",
            status: HttpCode.OK
        });
    } catch (error) {
        logger.error(error);
        // if the message is "Too many distinct filter attributes to retrieve. Please refine your time range.", return a 400 and the message
        if (
            error instanceof Error &&
            error.message ===
                "Too many distinct filter attributes to retrieve. Please refine your time range."
        ) {
            return next(createHttpError(HttpCode.BAD_REQUEST, error.message));
        }
        return next(
            createHttpError(HttpCode.INTERNAL_SERVER_ERROR, "An error occurred")
        );
    }
}
