# Shadowrun table — production image (see DEPLOY.md).
# Runtime data (tables, registry) lives in /app/runtime and the legacy Foundry assets in /app/data/assets/foundry:
# both are bind-mounted by docker-compose.yml so they survive rebuilds.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine
LABEL app=shadowrun-table
ENV NODE_ENV=production \
    PORT=3000 \
    SR_RUNTIME_DIR=/app/runtime \
    SR_BOOTSTRAP_TABLE=none \
    SR_FOUNDRY_LOCAL_PATHS=0 \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY client ./client
COPY data/seed ./data/seed
COPY data/packs ./data/packs
COPY data/catalog ./data/catalog
# Map library wall files (data/maplib/<slug>.json); the images are never in the image (.dockerignore, runtime/maplib/images)
COPY data/maplib ./data/maplib
# The app writes only to the mounted folders; everything else stays root-owned (read-only for the app user).
RUN mkdir -p /app/runtime /app/data/assets/foundry && chown -R node:node /app/runtime /app/data/assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1
CMD ["node", "server/index.js"]
