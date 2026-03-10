FROM node:22-alpine AS builder
WORKDIR /app

# Build tools for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package*.json turbo.json ./
COPY packages/shared/package*.json packages/shared/
COPY packages/core/package*.json packages/core/
COPY packages/discord/package*.json packages/discord/

RUN npm ci --workspaces

COPY packages/shared packages/shared
COPY packages/core packages/core
COPY packages/discord packages/discord

RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/core
RUN npm run build --workspace=packages/discord

FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache python3 make g++ && \
    addgroup -S agent && adduser -S agent -G agent

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/discord/dist ./packages/discord/dist
COPY --from=builder /app/packages/discord/package.json ./packages/discord/
COPY --from=builder /app/package.json ./

USER agent
CMD ["node", "packages/discord/dist/index.js"]
