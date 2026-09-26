# ---------- build web ----------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- build server ----------
FROM node:22-alpine AS server
WORKDIR /server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/web
WORKDIR /app
COPY --from=server /server/node_modules ./node_modules
COPY --from=server /server/dist ./dist
COPY --from=server /server/drizzle ./drizzle
COPY --from=server /server/package.json ./
COPY --from=web /web/dist ./web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/main.js"]
