# 给 Fly.io / 自己的 VPS 用。Render 用 render.yaml，Railway 用 railway.json（走 Nixpacks）。
# 注意：node:sqlite 在 22.13 / 23.4 之前需要 --experimental-sqlite 标志，所以基础镜像别降到 22。
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json next.config.mjs server.js ./
COPY server ./server
COPY public ./public

# SQLite 和 mp3 都落在这里 —— 部署时一定要挂一块持久磁盘上来，
# 否则每次重启都要把整份 transcript 重新 TTS 一遍。
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
