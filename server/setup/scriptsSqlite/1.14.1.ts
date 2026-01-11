import { __DIRNAME, APP_PATH } from "@server/lib/consts";
import Database from "better-sqlite3";
import path from "path";

const version = "1.14.1";

export default async function migration() {
    console.log(`Running setup script ${version}...`);

    const location = path.join(APP_PATH, "db", "db.sqlite");
    const db = new Database(location);

    try {
        db.pragma("foreign_keys = OFF");

        db.transaction(() => {
            // Add missing index on resources.fullDomain
            // This fixes the O(n) full table scan issue when looking up resources by domain
            // Without this index, every verify-session request without a cache hit performs
            // a sequential scan of the entire resources table, causing massive disk I/O
            db.prepare(
                `CREATE INDEX IF NOT EXISTS 'idx_resources_fullDomain' ON 'resources'('fullDomain');`
            ).run();
        })();

        db.pragma("foreign_keys = ON");

        console.log(`Migrated database`);
    } catch (e) {
        console.log("Failed to migrate db:", e);
        throw e;
    }

    console.log(`${version} migration complete`);
}
