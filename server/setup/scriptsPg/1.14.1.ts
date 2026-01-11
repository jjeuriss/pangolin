import { sql } from "drizzle-orm";
import { db } from "@server/db/pg";

const version = "1.14.1";

export default async function migration() {
    console.log(`Running setup script ${version}...`);

    try {
        // Add missing index on resources.fullDomain
        // This fixes the O(n) full table scan issue when looking up resources by domain
        // Without this index, every verify-session request without a cache hit performs
        // a sequential scan of the entire resources table, causing massive disk I/O
        await db.execute(
            sql.raw(`CREATE INDEX IF NOT EXISTS idx_resources_fullDomain ON resources(fullDomain);`)
        );

        console.log(`Migrated database`);
    } catch (e) {
        console.log("Failed to migrate db:", e);
        throw e;
    }

    console.log(`${version} migration complete`);
}
