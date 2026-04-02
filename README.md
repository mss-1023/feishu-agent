# Feishu Agent（飞书 Agent 服务）

基于 Claude Agent SDK 的飞书机器人，支持多会话管理、工具调用权限审批、流式输出、运行时安全边界和每日 AI 知识推送。




## 架构

```
用户 (飞书客户端)
      │
      ▼
┌─────────────────────────────────────┐
│  TS Service (:9800)                 │
│  Express + 飞书 SDK                 │
│  WebSocket / Webhook 双模式         │
│                                     │
│  ┌─ SessionManager                  │
│  │  ├─ SessionGroup (per user/chat) │
│  │  │  └─ ClaudeSession             │
│  │  │     ├─ Claude Agent SDK       │
│  │  │     ├─ QueueManager           │
│  │  │     ├─ PermissionManager      │
│  │  │     └─ StreamHandler          │
│  │  └─ SQLite 持久化               │
│  │                                  │
│  ├─ RuntimeBoundary (安全边界)      │
│  ├─ CardHandler (卡片交互)          │
│  ├─ CommandRouter (斜杠命令)        │
│  └─ DailyPush (每日 AI 知识推送)    │
└─────────────────────────────────────┘
```

## 功能

- Claude Agent SDK 集成（Claude CLI 作为 Agent 运行时）
- 飞书 WebSocket 长连接 + Webhook 双模式
- 多会话管理（创建、切换、重命名、删除）
- 权限审批系统（飞书卡片审批、bypass 模式、smart bypass）
- 运行时安全边界（路径白名单、bash 命令解析、危险命令拦截）
- 流式输出 + 卡片实时更新
- 每日 AI 知识推送（30 个主题按天轮换，定时发送到飞书群）
- 附件处理（图片、文件下载）
- SQLite 持久化（会话状态）
- Pino 结构化日志 + 日志脱敏
- Zod schema 运行时校验
- Nacos 配置中心热更新（可选）
- Skill 建议系统
- 优雅关闭（等待队列处理完成）
- macOS launchd 自启（开机自动运行、崩溃自动重启）

## 项目结构

```
├── src/
│   ├── index.ts                          # 入口（Express + 飞书 SDK + 定时任务）
│   ├── logger.ts                         # Pino 结构化日志 + 脱敏
│   ├── types.ts                          # 共享类型定义
│   ├── config/
│   │   ├── config.ts                     # Zod schema 配置（settings + paths）
│   │   ├── config-loader.ts              # .env.local + application.properties 加载
│   │   └── config-nacos.ts               # Nacos 远程配置 + 热更新
│   ├── feishu/
│   │   ├── sender.ts                     # 飞书 API 封装（消息/卡片/附件/表情）
│   │   ├── cards.ts                      # 飞书卡片构建器
│   │   └── schemas.ts                    # 飞书事件 Zod Schema
│   └── core/
│       ├── card-handler.ts               # 卡片动作处理（权限审批/会话切换）
│       ├── daily-push.ts                 # 每日 AI 知识推送
│       ├── message/
│       │   ├── message-handler.ts        # 消息处理主流程
│       │   ├── command-router.ts         # 斜杠命令路由
│       │   ├── dedup.ts                  # 消息去重（双缓冲 TTL）
│       │   ├── prompt.ts                 # Prompt 构建
│       │   └── attachment-extractor.ts   # 附件提取
│       ├── session/
│       │   ├── session-manager.ts        # 会话管理器（生命周期 + 持久化）
│       │   ├── session-group.ts          # 会话分组（多会话管理）
│       │   ├── session.ts                # Claude 会话核心（队列 + 权限 + 流式）
│       │   ├── queue-manager.ts          # 消息队列（背压控制）
│       │   ├── permission-manager.ts     # 权限审批管理（超时自动 deny）
│       │   ├── permission-handler.ts     # 权限决策链
│       │   ├── stream-handler.ts         # 流式输出缓冲
│       │   ├── storage.ts                # SQLite 持久化
│       │   └── claude-spawner.ts         # Claude CLI 进程创建
│       ├── runtime/
│       │   ├── claude-runtime.ts         # Claude 运行时环境配置
│       │   └── stream-parser.ts          # SSE 流事件解析
│       ├── boundary/
│       │   ├── allowlist.ts              # 路径白名单 + 工具边界评估
│       │   ├── bash-parser.ts            # Bash 命令分词 + 路径提取
│       │   └── path-utils.ts             # 路径工具函数
│       └── skills/
│           └── skills.ts                 # Skill 建议管理
├── claude/
│   ├── CLAUDE.md                         # Claude 系统提示词
│   ├── settings.json                     # Claude 权限配置
│   ├── mcp.json                          # MCP 服务器配置
│   ├── skills/                           # Claude Skills
│   └── scripts/                          # Claude Scripts
├── deploy/
│   ├── systemd/feishu-claude-agent.service  # Linux systemd 服务
│   └── mount-allowlist.example.json         # 路径白名单示例
├── docker/
│   └── entrypoint-ts.sh                  # Docker 入口脚本
├── Dockerfile                            # 多阶段构建
├── com.feishu.agent.plist                # macOS launchd 自启配置
└── application.properties                # Nacos 配置（可选）
```

## 快速开始

### 1. 环境要求

- Node.js >= 22（推荐 nvm）
- Claude CLI（`npm install -g @anthropic-ai/claude-code`）

### 2. 安装

```bash
nvm use 24
npm install
```

### 3. 配置

```bash
cp .env.local.example .env.local
# 编辑 .env.local 填入飞书和 Claude 配置
```

### 4. 启动

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run build && npm start
```

### 5. macOS 自启（launchd）

```bash
# 先构建
npm run build

# 安装 launchd 服务（开机自启 + 崩溃自动重启）
sudo cp com.feishu.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.feishu.agent.plist

# 查看状态
launchctl list | grep feishu.agent

# 停止
launchctl unload ~/Library/LaunchAgents/com.feishu.agent.plist
```

注意：plist 中的 Node.js 路径和项目路径需要根据实际环境修改。

### 6. Docker 部署

```bash
docker build -t feishu-agent .
docker run -d \
  --env-file .env.local \
  -v /workspace:/workspace \
  -p 9800:9800 \
  feishu-agent
```

## 用户命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/new [name]` | 创建新会话 |
| `/switch <name>` | 切换会话 |
| `/list` | 列出所有会话 |
| `/rename <name>` | 重命名当前会话 |
| `/delete <name>` | 删除非活跃会话 |
| `/reset` | 重置当前会话 |
| `/restart` | 保存状态并重启服务 |

Bypass 模式：发送 `我要开启bypass模式` 开启（5 分钟内工具调用自动放行），发送 `退出bypass模式` 关闭。

## 每日 AI 知识推送

- 每天 09:00 自动推送到配置的飞书群聊
- 30 个 AI 主题按天轮换（ML 基础 → LLM → Prompt → RAG → Agent → 工程实践）
- 调用 Claude API 生成学习内容，飞书紫色卡片展示
- `POST /push/test` 手动触发测试
- 通过 `PUSH_TARGET_GROUPS` 配置目标群聊

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/healthz` | K8s 就绪探针 |
| POST | `/event` | 飞书事件回调 |
| POST | `/card` | 飞书卡片动作回调 |
| POST | `/push/test` | 手动触发每日推送 |

## 配置说明

配置优先级：环境变量 > Nacos 远程 > application.properties

本地开发使用 `.env.local`，存在该文件时自动跳过 Nacos。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FEISHU_APP_ID` | — | 飞书应用 App ID（必需） |
| `FEISHU_APP_SECRET` | — | 飞书应用 App Secret（必需） |
| `FEISHU_ENCRYPT_KEY` | — | 飞书事件加密 Key |
| `FEISHU_VERIFICATION_TOKEN` | — | 飞书事件验证 Token |
| `FEISHU_USE_WS` | true | 使用 WebSocket 长连接 |
| `SERVER_PORT` | 9800 | 服务端口 |
| `ANTHROPIC_BASE_URL` | — | Claude API 代理地址 |
| `ANTHROPIC_AUTH_TOKEN` | — | Claude API 认证 Token |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | claude-opus-4-6 | Opus 模型名 |
| `HOST_PATH_ALLOWLIST` | — | 路径白名单（分号分隔） |
| `RUNTIME_BOUNDARY_ENABLED` | true | 启用运行时边界 |
| `PROTECT_PROJECT_CODE` | true | 保护项目源码不被修改 |
| `PUSH_ENABLED` | true | 启用每日推送 |
| `PUSH_HOUR` | 9 | 推送时间（小时） |
| `PUSH_MINUTE` | 0 | 推送时间（分钟） |
| `PUSH_TARGET_USERS` | — | 推送目标用户 open_id（逗号分隔） |
| `PUSH_TARGET_GROUPS` | — | 推送目标群聊 chat_id（逗号分隔） |

## 技术栈

- TypeScript / Express 5 / Node.js 24
- `@anthropic-ai/claude-agent-sdk`（Claude Agent 运行时）
- `@anthropic-ai/sdk`（Claude API 直接调用）
- `@larksuiteoapi/node-sdk`（飞书官方 SDK）
- SQLite（`node:sqlite`，Node.js 内置）
- Pino（结构化日志 + 脱敏）
- Zod（运行时校验）
- vitest + fast-check（测试）
