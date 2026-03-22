# TS 部署说明

## 1. 本地启动

```bash
npm install
npm run build
npm start
```

本地开发建议先复制环境变量模板：
本地直接维护仓库根目录下的 `.env.local`。

至少需要填写：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_DEFAULT_OPUS_MODEL`

## 2. SQLite 持久化

当前会话状态已经切到 SQLite，默认文件位置：

- `SESSION_BASE_DIR/state.db`

SQLite 开启了 `WAL`，运行时还会看到：

- `state.db-wal`
- `state.db-shm`

生产环境必须把 `SESSION_BASE_DIR` 所在目录挂到持久卷，否则容器重启后会话状态会丢失。

旧版 `sessions.json` / `skill_suggestions.json` 只用于一次性迁移兼容，新状态不再写回 JSON。

## 3. 容器部署

你现在的生产方式是直接基于 `Dockerfile` 构建镜像并运行容器，这种模式可以直接用，不需要 `docker-compose.yml`。

容器里至少要挂这几个持久目录：

- `/workspace/feishu_sessions_ts`
- `/workspace/uploads`

如果你把 `SESSION_BASE_DIR`、`UPLOAD_DIR` 改到了别的路径，就挂你自己的实际路径。

## 4. allowlist 与挂载

运行边界不是只靠配置文件，必须同时满足两件事：

1. 目录已经通过 Docker volume 挂进容器
2. 路径已经写进 allowlist

推荐把额外项目统一挂到 `/allowed/*`，例如：

```yaml
volumes:
  - /srv/repos/project-a:/allowed/project-a:rw
  - /srv/data/shared-docs:/allowed/shared-docs:ro
```

然后把同样的路径写进：

- `deploy/mount-allowlist.example.json`

示例：

```json
{
  "paths": [
    "/workspace",
    "/allowed/project-a",
    "/allowed/shared-docs"
  ]
}
```

## 5. Docker Compose

`docker-compose.yml` 现在只适合本地联调，不是生产必需项。

本地如果想用：

```bash
docker compose up -d --build
docker compose logs -f
```

## 6. systemd

示例文件：

- `deploy/systemd/feishu-claude-agent.service`

安装：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/feishu-claude-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now feishu-claude-agent.service
```

前提：

- 已执行过 `npm run build`
- `WorkingDirectory` 指向你的仓库目录
- `.env.local` 已放在仓库根目录

## 7. 模式切换

默认推荐 `FEISHU_USE_WS=true`，即 WebSocket 模式。

如果要走公网 webhook：

- 将 `FEISHU_USE_WS=false`
- 暴露 `9800`
- 飞书后台把事件地址指向 `/event`

## 8. 项目内 Claude 配置

当前仓库不再依赖宿主机 `~/.claude`。

请把下面这些内容直接维护在仓库里：

- `claude/CLAUDE.md`
- `claude/settings.json`
- `claude/mcp.json`
- `claude/skills/`
- `claude/scripts/`

其中：

- skills 放到 `claude/skills/<skill-name>/SKILL.md`
- MCP 服务器放到 `claude/mcp.json`

如果 MCP 需要敏感头，不要把明文写进仓库，直接在 `claude/mcp.json` 里使用 `${ENV_VAR}`，再在 `.env.local` 中提供实际值。
