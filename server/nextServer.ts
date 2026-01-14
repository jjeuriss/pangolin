import next from "next";
import express from "express";
import { parse } from "url";
import logger from "@server/logger";
import config from "@server/lib/config";
import { stripDuplicateSesions } from "./middlewares/stripDuplicateSessions";

const nextPort = config.getRawConfig().server.next_port;

export async function createNextServer() {
    // Use NODE_ENV for production detection (standard Node.js convention)
    // ENVIRONMENT is also checked for backwards compatibility
    const isDev =
        process.env.NODE_ENV !== "production" &&
        process.env.ENVIRONMENT !== "prod";

    const app = next({
        dev: isDev,
        // Only use turbopack in development for faster builds
        turbopack: isDev
    });
    const handle = app.getRequestHandler();

    await app.prepare();

    const nextServer = express();

    nextServer.use(stripDuplicateSesions);

    nextServer.all("/{*splat}", (req, res) => {
        const parsedUrl = parse(req.url!, true);
        return handle(req, res, parsedUrl);
    });

    nextServer.listen(nextPort, (err?: any) => {
        if (err) throw err;
        logger.info(
            `Next.js server is running on http://localhost:${nextPort}`
        );
    });

    return nextServer;
}
