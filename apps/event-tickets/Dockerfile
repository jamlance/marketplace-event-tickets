# Multi-stage build for Pre-orders.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/event-tickets ./apps/event-tickets
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/event-tickets
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/event-tickets/package.json ./apps/event-tickets/package.json
COPY --from=builder /work/apps/event-tickets/node_modules ./apps/event-tickets/node_modules
COPY --from=builder /work/apps/event-tickets/dist ./apps/event-tickets/dist
COPY apps/event-tickets/server.js ./apps/event-tickets/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/event-tickets
CMD ["node", "server.js"]
