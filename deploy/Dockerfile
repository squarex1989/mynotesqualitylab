# syntax=docker/dockerfile:1

# node:sqlite 在 22.13 / 23.4 之前需要 --experimental-sqlite 标志，
# 所以基础镜像别降到 22.13 以下。
ARG NODE_VERSION=24-slim

# ---- 全量依赖（含 devDependencies，next build 需要 typescript / @types）----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 构建 ----
FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json next.config.mjs tsconfig.json ./
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY public ./public
RUN npm run build

# ---- 只装生产依赖，运行时镜像不带 devDependencies ----
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 运行时 ----
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# SQLite 和 mp3 都落在这里。部署时一定要把持久卷挂到这个路径 ——
# 不挂的话每次重部署，整份 transcript 都要重新 TTS 一遍。
ENV DATA_DIR=/data

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json next.config.mjs server.js ./
COPY server ./server
COPY public ./public

# PORT 由平台注入（Railway / Fly 都会设），代码直接读 process.env.PORT。
# 这里只是给本地 docker run 一个默认值。
EXPOSE 3000

CMD ["node", "server.js"]
