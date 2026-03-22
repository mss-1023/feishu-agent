# =====================================================================
# Stage 1: Build TypeScript service
FROM node:22-slim AS build

ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY application.properties ./application.properties

RUN npm run build

# =====================================================================
# Stage 2: Runtime image
FROM node:22-slim
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code --unsafe-perm \
    && claude --version

ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY claude ./claude
COPY application.properties ./application.properties
COPY docker/entrypoint-ts.sh /app/docker/entrypoint-ts.sh

RUN chmod +x /app/docker/entrypoint-ts.sh \
    && mkdir -p /workspace/feishu_sessions_ts /workspace/uploads

ENV CLAUDE_CLI_PATH="/usr/local/bin/claude" \
    CLAUDE_WORK_DIR="/workspace" \
    SESSION_BASE_DIR="/workspace/feishu_sessions_ts" \
    UPLOAD_DIR="/workspace/uploads" \
    SERVER_PORT="9800" \
    FEISHU_USE_WS="true" \
    LOG_LEVEL="info" \
    NODE_ENV="production"

EXPOSE 9800

ENTRYPOINT ["/app/docker/entrypoint-ts.sh"]
CMD ["node", "dist/index.js"]
