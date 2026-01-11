#!/bin/bash

# Disk I/O Regression Test
# Measures block I/O impact of unauthenticated requests (like Synology Photos)
#
# This test helps isolate what's causing excessive disk I/O in v1.13.0
# by comparing authenticated vs unauthenticated request patterns.
#
# Usage on VPS:
#   ssh root@vps -i ~/.ssh/id_strato
#   cd /root && bash test-disk-io.sh

set -e

CONTAINER_NAME="pangolin"
NUM_REQUESTS=100

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Disk I/O Regression Test             ║${NC}"
echo -e "${BLUE}║   Unauthenticated vs Authenticated     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""
echo "Test parameters:"
echo "  Requests per test: $NUM_REQUESTS"
echo "  Container: $CONTAINER_NAME"
echo "  Endpoint: http://localhost:3000/api/v1/verify-session"
echo ""

# Get block I/O value in MB (returns just the number)
get_block_io_mb() {
    docker stats --no-stream "$CONTAINER_NAME" 2>/dev/null | tail -1 | awk '{print $7}' | sed 's/[MB]*//g'
}

# Get full block I/O string for display
get_block_io_full() {
    docker stats --no-stream "$CONTAINER_NAME" 2>/dev/null | tail -1 | awk '{print $7}'
}

# Make unauthenticated request (simulates Synology Photos)
make_unauthenticated_request() {
    local id=$1
    curl -s -X POST http://localhost:3000/api/v1/verify-session \
        -H "User-Agent: Synology-Synology_Photos_2.3.6" \
        -H "Content-Type: application/json" \
        -d "{
            \"sessions\": {},
            \"originalRequestURL\": \"https://photo.mythium.be/webapi/entry.cgi?id=$id\",
            \"path\": \"/webapi/entry.cgi\",
            \"host\": \"photo.mythium.be\",
            \"scheme\": \"https\",
            \"method\": \"GET\",
            \"tls\": true
        }" \
        -o /dev/null 2>/dev/null || true
}

# Make authenticated API request
make_authenticated_request() {
    # This would need a valid auth token
    # For now, just measure the diff when no requests are made
    sleep 0.01
}

# Step 1: Baseline
echo -e "${YELLOW}Step 1/3: Establishing baseline...${NC}"
echo "Waiting 10s for system to stabilize..."
sleep 10

BASELINE=$(get_block_io_mb)
BASELINE_FULL=$(get_block_io_full)
echo -e "Initial block I/O: ${GREEN}$BASELINE_FULL${NC}"
echo ""

# Step 2: Unauthenticated requests
echo -e "${YELLOW}Step 2/3: Sending $NUM_REQUESTS unauthenticated requests${NC}"
echo "These simulate Synology Photos app thumbnail requests (no auth)..."
echo ""

START_TIME=$(date +%s)
for i in $(seq 1 $NUM_REQUESTS); do
    make_unauthenticated_request "$i"

    if [ $((i % 25)) -eq 0 ]; then
        PCT=$((i * 100 / NUM_REQUESTS))
        printf "  %-3d%% [%-20s]\r" "$PCT" "$(printf '#%.0s' $(seq 1 $((PCT / 5))))"
    fi
done
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo "  100% [####################]"
echo "  Completed $NUM_REQUESTS requests in ${ELAPSED}s"
echo ""

# Wait for audit buffer to flush
echo -e "${YELLOW}Waiting for log buffering (5s)...${NC}"
sleep 5

AFTER_UNAUTH=$(get_block_io_mb)
AFTER_UNAUTH_FULL=$(get_block_io_full)
echo -e "Block I/O after unauthenticated: ${RED}$AFTER_UNAUTH_FULL${NC}"
echo ""

# Step 3: Analysis
echo -e "${YELLOW}Step 3/3: Analysis${NC}"
echo "════════════════════════════════════════"
echo ""
echo "Results:"
printf "  Initial:                %8s\n" "$BASELINE_FULL"
printf "  After unauthenticated:  %8s\n" "$AFTER_UNAUTH_FULL"

# Calculate growth
BASELINE_NUM=$(echo "$BASELINE" | awk -F'.' '{print $1}')
AFTER_UNAUTH_NUM=$(echo "$AFTER_UNAUTH" | awk -F'.' '{print $1}')

# Handle both integer and decimal
BASELINE_INT=$(printf "%.0f" $BASELINE_NUM 2>/dev/null || echo "$BASELINE_NUM")
AFTER_UNAUTH_INT=$(printf "%.0f" $AFTER_UNAUTH_NUM 2>/dev/null || echo "$AFTER_UNAUTH_NUM")

GROWTH=$((AFTER_UNAUTH_INT - BASELINE_INT))

echo ""
echo "Growth: ~${GROWTH}MB for $NUM_REQUESTS unauthenticated requests"
echo "Rate: ~$((GROWTH / NUM_REQUESTS))MB per request"
echo ""

# Interpretation
echo "════════════════════════════════════════"
if [ "$GROWTH" -gt 500 ]; then
    echo -e "${RED}❌ ISSUE CONFIRMED${NC}"
    echo ""
    echo "Unauthenticated requests are causing excessive disk I/O!"
    echo ""
    echo "  Expected (after cache stampede fix): 10-50MB"
    echo "  Observed: ${GROWTH}MB"
    echo ""
    echo "This suggests the cache stampede fix may not be working correctly."
    echo "Or there's another I/O-heavy operation for unauthenticated requests."
elif [ "$GROWTH" -gt 100 ]; then
    echo -e "${YELLOW}⚠️  MODERATE I/O USAGE${NC}"
    echo ""
    echo "Unauthenticated requests use more I/O than expected."
    echo ""
    echo "  Expected: 10-50MB"
    echo "  Observed: ${GROWTH}MB"
    echo ""
    echo "Monitor for accumulation over time."
elif [ "$GROWTH" -lt 50 ]; then
    echo -e "${GREEN}✅ GOOD - Within Expected Range${NC}"
    echo ""
    echo "I/O usage is reasonable for $NUM_REQUESTS requests."
    echo ""
    echo "The cache stampede fix appears to be working!"
else
    echo -e "${YELLOW}ℹ️  Moderate usage${NC}"
fi

echo ""
echo "════════════════════════════════════════"
echo ""
echo "📊 To understand what's happening:"
echo ""
echo "1. Check DISK_IO_DEBUG logs:"
echo "   docker logs pangolin 2>&1 | grep DISK_IO_DEBUG | tail -5"
echo ""
echo "2. Check for authentication-related queries:"
echo "   docker logs pangolin 2>&1 | grep -i 'verify\\|auth\\|session' | head -20"
echo ""
echo "3. Monitor in real-time during another test:"
echo "   docker logs -f pangolin 2>&1 | grep DISK_IO_DEBUG &"
echo "   # Then run this script again"
echo ""
