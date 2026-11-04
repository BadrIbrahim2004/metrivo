# Metrivo API — production image (multi-stage)
# Build context: apps/api/

# ---- Stage 1: build ----
FROM node:22-alpine AS build
WORKDIR /app

# Install all dependencies (incl. dev) needed for prisma generate + nest build
COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx nest build

# Prune dev dependencies for a lean runtime layer
RUN npm prune --omit=dev

# ---- Stage 2: runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as a non-root user
RUN addgroup -S metrivo && adduser -S metrivo -G metrivo

COPY --from=build --chown=metrivo:metrivo /app/node_modules ./node_modules
COPY --from=build --chown=metrivo:metrivo /app/dist ./dist
COPY --from=build --chown=metrivo:metrivo /app/prisma ./prisma
COPY --from=build --chown=metrivo:metrivo /app/package.json ./package.json
COPY --from=build --chown=metrivo:metrivo /app/prisma/baseline ./prisma/baseline
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER metrivo
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
