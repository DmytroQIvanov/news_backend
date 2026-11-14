# First build uses npm install to work without a pre-generated lockfile.
# After you run npm install locally and commit package-lock.json, switch to npm ci for reproducible builds.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN if test -f package-lock.json; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/migrations ./migrations
COPY --from=builder --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.cjs && node dist/main.js"]
