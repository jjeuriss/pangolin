import NodeCache from "node-cache";
import logger from "@server/logger";

// Create cache with conservative limits to reduce memory usage
// - stdTTL: 5 minutes (reduced from 1 hour) - most cache lookups are repeated
//   within minutes, so shorter TTL provides similar hit rates with lower memory
// - maxKeys: 5000 (reduced from 10000) - sufficient for typical usage patterns
// - useClones: false - avoids memory overhead of cloning cached objects
//
// WARNING: useClones is false for memory efficiency. All callers MUST treat
// returned values as immutable. Mutating cached objects corrupts shared state
// and affects all subsequent cache retrievals.
export const cache = new NodeCache({
    stdTTL: 300,
    checkperiod: 60,
    maxKeys: 5000,
    useClones: false
});

// Log cache statistics periodically for monitoring
setInterval(() => {
    const stats = cache.getStats();
    logger.debug(
        `Cache stats - Keys: ${stats.keys}, Hits: ${stats.hits}, Misses: ${stats.misses}, Hit rate: ${stats.hits > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) : 0}%`
    );
}, 300000); // Every 5 minutes

export default cache;
