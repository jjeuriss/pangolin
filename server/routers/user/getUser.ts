import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { db } from "@server/db";
import { idp, users } from "@server/db";
import { eq } from "drizzle-orm";
import response from "@server/lib/response";
import HttpCode from "@server/types/HttpCode";
import createHttpError from "http-errors";
import logger from "@server/logger";
import cache from "@server/lib/cache";

// BUILD VERIFICATION: commit a5932f95 - Server-side caching for /api/v1/user endpoint (2026-01-20)
logger.info("[BUILD_VERIFICATION] getUser.ts loaded with server-side caching (commit a5932f95, 2026-01-20)");

async function queryUser(userId: string) {
    logger.debug(`[GET_USER] Querying database for userId=${userId}`);
    const startTime = performance.now();

    const [user] = await db
        .select({
            userId: users.userId,
            email: users.email,
            username: users.username,
            name: users.name,
            type: users.type,
            twoFactorEnabled: users.twoFactorEnabled,
            emailVerified: users.emailVerified,
            serverAdmin: users.serverAdmin,
            idpName: idp.name,
            idpId: users.idpId
        })
        .from(users)
        .leftJoin(idp, eq(users.idpId, idp.idpId))
        .where(eq(users.userId, userId))
        .limit(1);

    const duration = performance.now() - startTime;
    logger.debug(`[GET_USER] Database query completed for userId=${userId}, duration=${duration.toFixed(2)}ms, found=${!!user}`);

    return user;
}

export type GetUserResponse = NonNullable<
    Awaited<ReturnType<typeof queryUser>>
>;

export async function getUser(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<any> {
    try {
        const userId = req.user?.userId;

        if (!userId) {
            return next(
                createHttpError(HttpCode.UNAUTHORIZED, "User not found")
            );
        }

        // Check cache first
        const cacheKey = `user:${userId}`;
        let user = cache.get<GetUserResponse>(cacheKey);

        if (user) {
            logger.debug(`[GET_USER] Cache hit for userId=${userId}`);
        } else {
            logger.debug(`[GET_USER] Cache miss for userId=${userId}, querying database`);
            user = await queryUser(userId);

            if (user) {
                // Cache for 60 seconds
                cache.set(cacheKey, user, 60);
                logger.debug(`[GET_USER] Cached user data for userId=${userId}, ttl=60s`);
            }
        }

        if (!user) {
            return next(
                createHttpError(
                    HttpCode.NOT_FOUND,
                    `User with ID ${userId} not found`
                )
            );
        }

        return response<GetUserResponse>(res, {
            data: user,
            success: true,
            error: false,
            message: "User retrieved successfully",
            status: HttpCode.OK
        });
    } catch (error) {
        logger.error(error);
        return next(
            createHttpError(HttpCode.INTERNAL_SERVER_ERROR, "An error occurred")
        );
    }
}
