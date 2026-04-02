/**
 * 配置主模块 — Zod schema 校验，导出 settings 和 paths 供全局使用。
 * 配置优先级: 环境变量 > Nacos 远程 > application.properties。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { props, hasEnvLocal, parseBoolean, getValue } from './config-loader.js';
import { loadNacosConfig } from './config-nacos.js';
import { logger } from '../logger.js';


const projectDir = process.cwd();
const homeDir = os.homedir();

const nacosConfig = await loadNacosConfig(props, hasEnvLocal);

const configSchema = z.object({
  serverPort: z.coerce.number().default(9800),
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  encryptKey: z.string().default(''),
  verificationToken: z.string().default(''),
  useWebsocket: z.boolean().default(true),
  claudeModel: z.string().default('claude-opus-4-6'),
  claudeExecutable: z.string().default('claude'),
  claudeWorkDir: z.string().default(path.join(homeDir, 'workspace')),
  sessionBaseDir: z.string().default(path.join(homeDir, 'workspace', 'feishu_sessions_ts')),
  uploadDir: z.string().default(path.join(homeDir, 'workspace', 'uploads')),
  maxSessionQueueSize: z.coerce.number().default(20),
  feishuMaxRps: z.coerce.number().default(4),
  permissionTimeoutSeconds: z.coerce.number().default(60),
  streamFlushIntervalMs: z.coerce.number().default(1200),
  streamBufferMaxChars: z.coerce.number().default(6000),
  restartCommand: z.string().default('systemctl --user restart feishu-claude-agent.service'),
  runtimeBoundaryEnabled: z.boolean().default(true),
  hostPathAllowlist: z.string().default(''),
  hostPathAllowlistFile: z
    .string()
    .default(path.join(homeDir, '.config', 'ai-container', 'mount-allowlist.json')),
  protectProjectCode: z.boolean().default(true),
  sessionInactiveTimeoutMs: z.coerce.number().default(60 * 60 * 1000),
  bypassTimeoutSeconds: z.coerce.number().default(300),
  smartBypassTimeoutSeconds: z.coerce.number().default(600),
  cleanupIntervalMs: z.coerce.number().default(10 * 60 * 1000),
  saveIntervalMs: z.coerce.number().default(5 * 60 * 1000),
  uploadRetentionMs: z.coerce.number().default(24 * 60 * 60 * 1000),
  metricsIntervalMs: z.coerce.number().default(60 * 1000),
  shutdownTimeoutMs: z.coerce.number().default(30 * 1000),
  pushEnabled: z.boolean().default(true),
  pushHour: z.coerce.number().default(9),
  pushMinute: z.coerce.number().default(0),
  pushTargetUsers: z.preprocess(
    (val) => (typeof val === 'string' ? val.split(',').map((s: string) => s.trim()).filter(Boolean) : val),
    z.array(z.string()).default([]),
  ),
  pushTargetGroups: z.preprocess(
    (val) => (typeof val === 'string' ? val.split(',').map((s: string) => s.trim()).filter(Boolean) : val),
    z.array(z.string()).default([]),
  ),
  errorReportEnabled: z.boolean().default(true),
  errorReportHour: z.coerce.number().default(18),
  errorReportMinute: z.coerce.number().default(0),
  errorReportChatId: z.string().default(''),
});

export const settings = configSchema.parse({
  serverPort: getValue('SERVER_PORT', '9800', nacosConfig),
  appId: getValue('FEISHU_APP_ID', '', nacosConfig),
  appSecret: getValue('FEISHU_APP_SECRET', '', nacosConfig),
  encryptKey: getValue('FEISHU_ENCRYPT_KEY', '', nacosConfig),
  verificationToken: getValue('FEISHU_VERIFICATION_TOKEN', '', nacosConfig),
  useWebsocket: parseBoolean(getValue('FEISHU_USE_WS', 'true', nacosConfig), true),
  claudeModel: getValue('ANTHROPIC_DEFAULT_OPUS_MODEL', 'claude-opus-4-6', nacosConfig),
  claudeExecutable: getValue('CLAUDE_CLI_PATH', 'claude', nacosConfig),
  claudeWorkDir: getValue('CLAUDE_WORK_DIR', path.join(homeDir, 'workspace'), nacosConfig),
  sessionBaseDir: getValue(
    'SESSION_BASE_DIR',
    path.join(homeDir, 'workspace', 'feishu_sessions_ts'),
    nacosConfig,
  ),
  uploadDir: getValue('UPLOAD_DIR', path.join(homeDir, 'workspace', 'uploads'), nacosConfig),
  maxSessionQueueSize: getValue('MAX_SESSION_QUEUE_SIZE', '20', nacosConfig),
  feishuMaxRps: getValue('FEISHU_MAX_RPS', '4', nacosConfig),
  permissionTimeoutSeconds: getValue('PERMISSION_TIMEOUT', '60', nacosConfig),
  streamFlushIntervalMs: getValue('STREAM_BUFFER_FLUSH_INTERVAL', '1200', nacosConfig),
  streamBufferMaxChars: getValue('STREAM_BUFFER_MAX_SIZE', '6000', nacosConfig),
  restartCommand: getValue(
    'SERVICE_RESTART_COMMAND',
    'systemctl --user restart feishu-claude-agent.service',
    nacosConfig,
  ),
  runtimeBoundaryEnabled: parseBoolean(getValue('RUNTIME_BOUNDARY_ENABLED', 'true', nacosConfig), true),
  hostPathAllowlist: getValue('HOST_PATH_ALLOWLIST', '', nacosConfig),
  hostPathAllowlistFile: getValue(
    'HOST_PATH_ALLOWLIST_FILE',
    path.join(homeDir, '.config', 'ai-container', 'mount-allowlist.json'),
    nacosConfig,
  ),
  protectProjectCode: parseBoolean(getValue('PROTECT_PROJECT_CODE', 'true', nacosConfig), true),
  sessionInactiveTimeoutMs: getValue('SESSION_INACTIVE_TIMEOUT_MS', String(60 * 60 * 1000), nacosConfig),
  bypassTimeoutSeconds: getValue('BYPASS_TIMEOUT_SECONDS', '300', nacosConfig),
  smartBypassTimeoutSeconds: getValue('SMART_BYPASS_TIMEOUT_SECONDS', '600', nacosConfig),
  cleanupIntervalMs: getValue('CLEANUP_INTERVAL_MS', String(10 * 60 * 1000), nacosConfig),
  saveIntervalMs: getValue('SAVE_INTERVAL_MS', String(5 * 60 * 1000), nacosConfig),
  uploadRetentionMs: getValue('UPLOAD_RETENTION_MS', String(24 * 60 * 60 * 1000), nacosConfig),
  metricsIntervalMs: getValue('METRICS_INTERVAL_MS', String(60 * 1000), nacosConfig),
  shutdownTimeoutMs: getValue('SHUTDOWN_TIMEOUT_MS', String(30 * 1000), nacosConfig),
  pushEnabled: parseBoolean(getValue('PUSH_ENABLED', 'true', nacosConfig), true),
  pushHour: getValue('PUSH_HOUR', '9', nacosConfig),
  pushMinute: getValue('PUSH_MINUTE', '0', nacosConfig),
  pushTargetUsers: getValue('PUSH_TARGET_USERS', '', nacosConfig)
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean),
  pushTargetGroups: getValue('PUSH_TARGET_GROUPS', '', nacosConfig)
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean),
  errorReportEnabled: parseBoolean(getValue('ERROR_REPORT_ENABLED', 'true', nacosConfig), true),
  errorReportHour: getValue('ERROR_REPORT_HOUR', '18', nacosConfig),
  errorReportMinute: getValue('ERROR_REPORT_MINUTE', '0', nacosConfig),
  errorReportChatId: getValue('ERROR_REPORT_CHAT_ID', '', nacosConfig),
});

/**
 * 将 Nacos / application.properties 中的配置回写到 process.env，
 * 使下游通过 process.env 消费的模块（Claude 子进程、MCP 插值等）也能拿到值。
 * 仅在 process.env 中尚未设置时才写入，保持"环境变量优先"的语义。
 */
const envPassthroughKeys = [
  // 模型网关
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  // Jira MCP
  'JIRA_MCP_JIRA_URL',
  'JIRA_MCP_USERNAME',
  'JIRA_MCP_PERSONAL_TOKEN',
] as const;

for (const key of envPassthroughKeys) {
  const value = getValue(key, '', nacosConfig);
  if (value && !process.env[key]) {
    process.env[key] = value;
  }
}

export const CONSTANTS = {
  LOG_SUMMARY_MAX_LENGTH: 120,
  STDERR_BUFFER_MAX_CHARS: 4000,
  STREAM_CARD_TRUNCATE_LENGTH: 6000,
  COMMAND_SUBSTITUTION_MAX_DEPTH: 3,
} as const;

/** 可热更新的 settings 字段集合 */
export const HOT_RELOADABLE_KEYS = new Set<string>([
  'claudeModel',
  'feishuMaxRps',
  'permissionTimeoutSeconds',
  'streamFlushIntervalMs',
  'streamBufferMaxChars',
  'maxSessionQueueSize',
]);

/** Nacos 配置键 → settings 字段名的映射 */
const NACOS_KEY_TO_SETTINGS: Record<string, keyof typeof settings> = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claudeModel',
  FEISHU_MAX_RPS: 'feishuMaxRps',
  PERMISSION_TIMEOUT: 'permissionTimeoutSeconds',
  STREAM_BUFFER_FLUSH_INTERVAL: 'streamFlushIntervalMs',
  STREAM_BUFFER_MAX_SIZE: 'streamBufferMaxChars',
  MAX_SESSION_QUEUE_SIZE: 'maxSessionQueueSize',
};

/**
 * 应用 Nacos 热更新配置。仅更新 HOT_RELOADABLE_KEYS 中的字段。
 * 使用 Zod schema 的 partial() 校验变更值，校验失败则拒绝整次更新。
 * 成功时记录变更字段的新旧值。
 */
export function applyHotReload(newConfig: Record<string, string>): void {
  // 从 Nacos 配置中提取可热更新字段的候选值
  const candidate: Record<string, unknown> = {};
  for (const [nacosKey, settingsKey] of Object.entries(NACOS_KEY_TO_SETTINGS)) {
    // 直接匹配或带前缀匹配（如 spring.xxx.KEY）
    let value: string | undefined = newConfig[nacosKey];
    if (value == null || value === '') {
      for (const [k, v] of Object.entries(newConfig)) {
        if (k.endsWith(`.${nacosKey}`) && v !== '') {
          value = v;
          break;
        }
      }
    }
    if (value != null && value !== '') {
      candidate[settingsKey] = value;
    }
  }

  if (Object.keys(candidate).length === 0) {
    logger.info('Nacos hot reload: no reloadable fields changed');
    return;
  }

  // 用 partial schema 校验候选值
  const partialSchema = configSchema.partial();
  const result = partialSchema.safeParse(candidate);
  if (!result.success) {
    logger.error(
      { errors: result.error.issues, candidate },
      'Nacos hot reload rejected: Zod validation failed',
    );
    return;
  }

  // 应用变更，记录新旧值
  const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
  for (const [key, newValue] of Object.entries(result.data)) {
    if (!HOT_RELOADABLE_KEYS.has(key)) {
      continue;
    }
    const oldValue = (settings as Record<string, unknown>)[key];
    if (oldValue !== newValue) {
      changes.push({ field: key, oldValue, newValue });
      (settings as Record<string, unknown>)[key] = newValue;
    }
  }

  if (changes.length === 0) {
    logger.info('Nacos hot reload: all values unchanged');
  } else {
    logger.info({ changes }, 'Nacos hot reload applied');
  }
}

export const paths = {
  projectDir,
  databaseFile: path.join(settings.sessionBaseDir, 'state.db'),
  stateFile: path.join(settings.sessionBaseDir, 'sessions.json'),
  workspacesDir: path.join(settings.sessionBaseDir, 'workspaces'),
  skillSuggestionsFile: path.join(settings.claudeWorkDir, 'skill_suggestions.json'),
  projectClaudeDir: path.join(projectDir, 'claude'),
  projectClaudePromptFile: path.join(projectDir, 'claude', 'CLAUDE.md'),
  projectClaudeSettingsFile: path.join(projectDir, 'claude', 'settings.json'),
  projectClaudeMcpFile: path.join(projectDir, 'claude', 'mcp.json'),
  projectClaudeSkillsDir: path.join(projectDir, 'claude', 'skills'),
  projectClaudeScriptsDir: path.join(projectDir, 'claude', 'scripts'),
  runtimeClaudeHome: path.join(settings.sessionBaseDir, 'runtime-home'),
  runtimeClaudeConfigDir: path.join(settings.sessionBaseDir, 'runtime-home', '.claude'),
};

for (const dir of [
  settings.claudeWorkDir,
  settings.sessionBaseDir,
  settings.uploadDir,
  paths.workspacesDir,
  paths.runtimeClaudeConfigDir,
]) {
  fs.mkdirSync(dir, { recursive: true });
}
