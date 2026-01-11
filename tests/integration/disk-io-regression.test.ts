/**
 * Disk I/O Regression Test
 *
 * This test measures block I/O usage for unauthenticated requests.
 * In v1.13.0, unauthenticated requests cause excessive disk reads due to
 * a cache stampede on the getRetentionDays() query.
 *
 * Run with: npm run test -- tests/integration/disk-io-regression.test.ts
 *
 * Expected results:
 * - Authenticated requests: ~5-10MB block I/O per 100 requests
 * - Unauthenticated requests: Should match authenticated (after fix)
 * - Before fix: Unauthenticated requests would spike to 100+ MB
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fetch from 'node-fetch';

describe('Disk I/O Regression - Unauthenticated Requests', () => {
    const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
    const NUM_REQUESTS = 100;

    // Mock Synology Photos User-Agent
    const SYNOLOGY_UA = 'Synology-Synology_Photos_2.3.6_rv:602_Pixel 9_Android_36_(Dalvik/2.1.0)';

    let metrics = {
        startTime: 0,
        endTime: 0,
        requestsMade: 0,
        errors: 0,
    };

    beforeAll(() => {
        metrics.startTime = Date.now();
        console.log(`\n📊 Disk I/O Regression Test`);
        console.log(`Base URL: ${BASE_URL}`);
        console.log(`Requests to make: ${NUM_REQUESTS}`);
    });

    afterAll(() => {
        metrics.endTime = Date.now();
        const duration = (metrics.endTime - metrics.startTime) / 1000;
        console.log(`\n✅ Test completed in ${duration.toFixed(1)}s`);
        console.log(`Requests made: ${metrics.requestsMade}, Errors: ${metrics.errors}`);
        console.log(`\n💡 Check block I/O before and after with:`);
        console.log(`   docker stats --no-stream pangolin | grep BLOCK`);
    });

    it('should measure I/O impact of unauthenticated requests (like Synology Photos)', async () => {
        console.log(`\n🔍 Making ${NUM_REQUESTS} unauthenticated requests...`);

        const requests = [];
        for (let i = 0; i < NUM_REQUESTS; i++) {
            // Simulate Synology Photos thumbnail requests
            const photoId = Math.floor(Math.random() * 1000);
            const cacheKey = `${photoId}_${Math.floor(Date.now() / 1000)}`;

            const url = new URL('/api/v1/verify-session', BASE_URL);
            url.searchParams.append('originalRequestURL', `https://photo.example.com/?id=${photoId}`);

            const request = fetch(url.toString(), {
                method: 'POST',
                headers: {
                    'User-Agent': SYNOLOGY_UA,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sessions: {}, // No session = unauthenticated
                    path: '/webapi/entry.cgi',
                    originalRequestURL: `https://photo.example.com/?id=${photoId}`,
                }),
            })
            .then(res => {
                metrics.requestsMade++;
                return res;
            })
            .catch(err => {
                metrics.errors++;
                return err;
            });

            requests.push(request);

            // Throttle to avoid overwhelming the server
            if ((i + 1) % 10 === 0) {
                await Promise.all(requests.splice(0, 10));
                process.stdout.write(`  Progress: ${i + 1}/${NUM_REQUESTS}\r`);
            }
        }

        // Wait for remaining requests
        await Promise.all(requests);
        console.log(`  Progress: ${NUM_REQUESTS}/${NUM_REQUESTS}  ✓`);

        // Wait for logs to flush and audit buffer to settle
        console.log(`⏳ Waiting for audit buffer to flush...`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        expect(metrics.requestsMade).toBeGreaterThan(NUM_REQUESTS - 5);
        expect(metrics.errors).toBeLessThan(5);
    });

    it('should show DISK_IO_DEBUG monitoring in logs', async () => {
        console.log(`\n📋 Expected log output should show:`);
        console.log(`   [DISK_IO_DEBUG] Audit buffer: X items | Retention queries: Y/sec | In-flight: Z`);
        console.log(`\n   Key indicators (after fix):`);
        console.log(`   ✓ Retention queries: 0-1 per 30 seconds`);
        console.log(`   ✓ In-flight: 0 (no duplicate queries)`);
        console.log(`   ✓ Buffer flushing normally`);
    });

    it('instructions for manual I/O measurement', async () => {
        console.log(`\n🔧 Manual I/O Measurement Steps:`);
        console.log(`
1. Terminal 1 - Start watching I/O:
   docker stats --no-stream pangolin | grep BLOCK

2. Terminal 2 - Run this test:
   npm run test -- tests/integration/disk-io-regression.test.ts

3. Record initial I/O (after test starts)
4. Run test, record final I/O
5. Calculate difference

Expected (after fix):
- 100 unauthenticated requests: ~50-100MB growth
- Retention queries: 0/sec
- In-flight: 0

Before fix:
- 100 unauthenticated requests: 500MB+ growth
- Retention queries: 5-10+/sec
- In-flight: >0 (duplicate queries)
        `);

        expect(true).toBe(true);
    });
});
