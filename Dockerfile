# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: Build
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Build deps: git (clone during tests), python3/make/g++ (better-sqlite3 compile)
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# package-lock.json is required for `npm ci`; copy both for layer caching.
COPY package.json package-lock.json ./
COPY tsconfig.json ./

# Full install: `npm run build` needs the TypeScript compiler (devDependency).
RUN npm ci

COPY src ./src

# Build the CLI, then prune devDependencies so the runtime image stays small.
RUN npm run build && npm prune --omit=dev

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: Production
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine

# Runtime deps: git (consumer clones) + openssh-client (ssh git URLs)
RUN apk add --no-cache git openssh-client

# Run as a non-root user.
RUN addgroup -g 1001 -S mantior && \
    adduser -u 1001 -S mantior -G mantior

WORKDIR /app

COPY --from=builder --chown=mantior:mantior /app/dist ./dist
COPY --from=builder --chown=mantior:mantior /app/node_modules ./node_modules
COPY --from=builder --chown=mantior:mantior /app/package.json ./

# Persist the SQLite state database.
VOLUME ["/app/.mantior"]

USER mantior

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

ENTRYPOINT ["node", "dist/index.js"]
CMD ["server"]
