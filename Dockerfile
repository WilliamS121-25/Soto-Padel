# Runs the app anywhere that can run a container.
#
# Point DATABASE_URL at a Postgres and no disk is needed at all. Without one,
# the app runs Postgres in-process against /data, and that directory then has to
# survive a restart — mount a volume there.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build needs no configuration: every route is server-rendered on demand.
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Only used when DATABASE_URL is not set: where the in-process database lives.
ENV DATABASE_PATH=/data/postgres

# Production dependencies only. Verified sufficient: `next start` loads the
# TypeScript next.config.ts without the typescript package present.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.ts ./next.config.ts

# Created so the app still starts with no volume attached. Without either a
# volume or DATABASE_URL the data is lost on restart, which is the one thing
# this setup exists to avoid.
RUN mkdir -p /data

EXPOSE 3000
CMD ["npm", "start"]
