# TS 重构状态

## 当前结论

本次重构主线已经完成，仓库默认运行路径已切到 `TypeScript + Claude Agent SDK`。
当前会话持久化也已从 JSON 切到 `SQLite`。

## 已完成项

- `src/` 下 TS 服务主线可构建、可运行
- 飞书 webhook / card / websocket 三条接入链路已打通
- 会话模型已迁到 TS，且改为每 session 独立 workspace
- Claude 执行主链路已改为 Agent SDK
- 会话状态与 skill suggestion 已切到 SQLite 持久化
- Docker 默认入口已切到 `node dist/index.js`
- 已补运行边界与 allowlist
- 已补 Docker Compose / systemd 部署文件
- 旧 Python 服务文件已移除
- 已移除对宿主机 `~/.claude` 的依赖

## 运行边界细节

- 默认根边界是当前 session 的 workspace
- 允许额外开放的路径由 allowlist 控制
- allowlist 支持环境变量和 JSON 文件两种来源
- 当前服务仓库默认保护，防止 bot 自改宿主项目代码
- 破坏性 Bash 命令直接拒绝
- 变更型写操作仍保留人工审批

## Claude 配置细节

- `claude/CLAUDE.md` 作为项目内系统提示词
- `claude/mcp.json` 作为项目内 MCP 配置
- `claude/skills/` 作为项目内唯一 skill 来源
- 启动时会生成项目专用 runtime Claude home，不再继承宿主机配置
- 本地环境变量统一使用仓库根目录下的 `.env.local`

## SQLite 持久化细节

- 默认数据库文件是 `SESSION_BASE_DIR/state.db`
- SQLite 会自动生成 `state.db-wal` 和 `state.db-shm`
- 启动时如果检测到旧 `sessions.json` / `skill_suggestions.json`，会尝试迁移到 SQLite
- 迁移完成后，新状态只写 SQLite，不再写回 JSON

## 剩余事项

没有阻塞 TS 主线交付的未完成项。

仍可继续增强但不影响当前完成度：

- 把 Bash 路径识别从启发式继续做得更细
- 补更完整的生产告警与监控
