# Runs the app on any host that can give it a persistent disk: Fly.io with a
# volume, Railway, Render with a disk, or a plain VPS. The database is a SQLite
# file, so the one hard requirement is that /data survives a restart.
#
# Debian-based rather than Alpine on purpose: better-sqlite3 is a native module
# and ships prebuilt binaries for glibc, so this avoids compiling it from source.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build reads no secrets: every route is server-rendered on demand, so
# ADMIN_PASSCODE and SESSION_SECRET are only needed at runtime.
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Where the volume gets mounted. Override if your host mounts somewhere else.
ENV DATABASE_PATH=/data/soto-padel.db

# Production dependencies only. Verified sufficient: `next start` loads the
# TypeScript next.config.ts without the typescript package present.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.ts ./next.config.ts

# Created so the app still starts if no volume is attached — though the database
# is then lost on restart, which is exactly what this setup exists to avoid.
RUN mkdir -p /data

EXPOSE 3000
CMD ["npm", "start"]
