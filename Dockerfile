FROM node:24-alpine AS builder

WORKDIR /app

ARG BUILD=oss
ARG DATABASE=sqlite

RUN apk add --no-cache curl tzdata python3 make g++

# COPY package.json package-lock.json ./
COPY package*.json ./
RUN npm ci

COPY . .

RUN echo "export * from \"./$DATABASE\";" > server/db/index.ts
RUN echo "export const driver: \"pg\" | \"sqlite\" = \"$DATABASE\";" >> server/db/index.ts

RUN echo "export const build = \"$BUILD\" as \"saas\" | \"enterprise\" | \"oss\";" > server/build.ts

# Copy the appropriate TypeScript configuration based on build type
RUN if [ "$BUILD" = "oss" ]; then cp tsconfig.oss.json tsconfig.json; \
    elif [ "$BUILD" = "saas" ]; then cp tsconfig.saas.json tsconfig.json; \
    elif [ "$BUILD" = "enterprise" ]; then cp tsconfig.enterprise.json tsconfig.json; \
    fi

# if the build is oss then remove the server/private directory
RUN if [ "$BUILD" = "oss" ]; then rm -rf server/private; fi

RUN if [ "$DATABASE" = "pg" ]; then npx drizzle-kit generate --dialect postgresql --schema ./server/db/pg/schema --out init; else npx drizzle-kit generate --dialect $DATABASE --schema ./server/db/$DATABASE/schema --out init; fi

RUN mkdir -p dist
RUN npm run next:build
RUN node esbuild.mjs -e server/index.ts -o dist/server.mjs -b $BUILD
RUN if [ "$DATABASE" = "pg" ]; then \
    node esbuild.mjs -e server/setup/migrationsPg.ts -o dist/migrations.mjs; \
    else \
    node esbuild.mjs -e server/setup/migrationsSqlite.ts -o dist/migrations.mjs; \
    fi

# test to make sure the build output is there and error if not
RUN test -f dist/server.mjs

RUN npm run build:cli

# Prune dev dependencies and clean up to prepare for copy to runner
RUN npm prune --omit=dev && npm cache clean --force

FROM node:24-alpine AS runner

WORKDIR /app

# Only curl and tzdata needed at runtime - no build tools!
RUN apk add --no-cache curl tzdata

# Copy pre-built node_modules from builder (already pruned to production only)
# This includes the compiled native modules like better-sqlite3
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/init ./dist/init
COPY --from=builder /app/package.json ./package.json

COPY ./cli/wrapper.sh /usr/local/bin/pangctl
RUN chmod +x /usr/local/bin/pangctl ./dist/cli.mjs

COPY server/db/names.json ./dist/names.json
COPY public ./public

# Set Node.js memory limits to prevent excessive memory usage
# 384MB provides adequate headroom above the ~180-270MB baseline
# (Next.js needs 150-200MB, plus Express servers and cache overhead)
ENV NODE_OPTIONS="--max-old-space-size=384"

CMD ["npm", "run", "start"]
