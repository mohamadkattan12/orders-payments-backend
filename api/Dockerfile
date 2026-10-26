FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma7.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json /app/prisma7.config.ts ./
USER node
# Apply migrations and the idempotent seed, then start.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/seed/run.js && node dist/main.js"]
