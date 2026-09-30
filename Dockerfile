# syntax=docker/dockerfile:1

# ---- deps: install all dependencies once, reused by the build stage ----
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# ---- builder: generate the Prisma client and build the Next.js app ----
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# A DATABASE_URL is required for `prisma generate` and for `next build`,
# which statically prerenders pages (e.g. every page renders the shared
# Header, which queries categories) and so needs a real, migrated — if
# empty — database at build time, not just a valid connection string.
ENV DATABASE_URL="file:./build-placeholder.db"
RUN npx prisma generate
RUN npx prisma migrate deploy
RUN npm run build

# ---- runner: production image. Serves the web app; the worker service   ----
# ---- (docker-compose) reuses this same image with a different command.  ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system --gid 1001 opennews \
    && adduser --system --uid 1001 --ingroup opennews opennews

COPY package.json package-lock.json ./
# prisma's own postinstall hook runs `prisma generate`, which needs
# prisma/schema.prisma to already be present — copy it in before `npm ci`.
COPY prisma ./prisma
ENV DATABASE_URL="file:./build-placeholder.db"
RUN npm ci --omit=dev --legacy-peer-deps

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY public ./public
COPY config ./config
COPY worker ./worker
COPY scripts ./scripts
COPY src ./src
COPY tsconfig.json next.config.ts ./
COPY docker/entrypoint.sh ./docker/entrypoint.sh
# /data is where docker-compose mounts the persistent SQLite volume; create
# it (owned by the non-root user) so a fresh named volume inherits
# writable ownership on first mount, instead of defaulting to root.
RUN chmod +x ./docker/entrypoint.sh \
    && mkdir -p /data \
    && chown -R opennews:opennews /app /data

USER opennews
EXPOSE 3000
ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["npm", "start"]
