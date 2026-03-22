/**
 * Claude 运行时环境 — 加载项目级 Claude 配置（system prompt、settings、MCP servers），构建运行时环境变量。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { paths } from '../../config/config.js';
import { logger } from '../../logger.js';

let runtimePrepared = false;

function copyDirectoryContents(sourceDir: string, targetDir: string) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function readJsonFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    logger.warn({ error, filePath }, 'failed to parse project claude json file');
    return null;
  }
}

function interpolateEnvString(value: string) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, envKey) => process.env[envKey] || '');
}

function interpolateEnvValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return interpolateEnvString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        interpolateEnvValue(child),
      ]),
    );
  }

  return value;
}

function ensureRuntimeAppDataDirs(homeDir: string) {
  const roaming = path.join(homeDir, 'AppData', 'Roaming');
  const local = path.join(homeDir, 'AppData', 'Local');
  fs.mkdirSync(roaming, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  return { roaming, local };
}

export function syncProjectClaudeRuntime() {
  fs.rmSync(paths.runtimeClaudeConfigDir, {
    recursive: true,
    force: true,
  });
  fs.mkdirSync(paths.runtimeClaudeConfigDir, { recursive: true });

  copyDirectoryContents(paths.projectClaudeSkillsDir, path.join(paths.runtimeClaudeConfigDir, 'skills'));
  copyDirectoryContents(paths.projectClaudeScriptsDir, path.join(paths.runtimeClaudeConfigDir, 'scripts'));

  if (fs.existsSync(paths.projectClaudeSettingsFile)) {
    fs.copyFileSync(
      paths.projectClaudeSettingsFile,
      path.join(paths.runtimeClaudeConfigDir, 'settings.json'),
    );
  }

  runtimePrepared = true;
}

function ensureProjectClaudeRuntime() {
  if (runtimePrepared) {
    return;
  }
  syncProjectClaudeRuntime();
}

export function loadProjectSystemPrompt() {
  if (!fs.existsSync(paths.projectClaudePromptFile)) {
    return undefined;
  }

  const content = fs.readFileSync(paths.projectClaudePromptFile, 'utf8').trim();
  return content || undefined;
}

export function loadProjectClaudeSettings() {
  const parsed = readJsonFile(paths.projectClaudeSettingsFile);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function loadProjectMcpServers() {
  const parsed = readJsonFile(paths.projectClaudeMcpFile);
  if (!parsed) {
    return undefined;
  }

  if (typeof parsed === 'object' && !Array.isArray(parsed)) {
    const objectValue = parsed as Record<string, unknown>;
    const nested = objectValue.mcpServers;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return interpolateEnvValue(nested) as Record<string, McpServerConfig>;
    }
    return interpolateEnvValue(objectValue) as Record<string, McpServerConfig>;
  }

  logger.warn({ filePath: paths.projectClaudeMcpFile }, 'project mcp config must be an object');
  return undefined;
}

export function buildProjectClaudeEnv(baseEnv: NodeJS.ProcessEnv) {
  ensureProjectClaudeRuntime();

  const runtimeHome = paths.runtimeClaudeHome;
  const claudeConfigDir = paths.runtimeClaudeConfigDir;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };

  if (process.platform === 'win32') {
    const parsed = path.parse(runtimeHome);
    env.HOMEDRIVE = parsed.root.slice(0, 2) || parsed.root;
    env.HOMEPATH = runtimeHome.slice(parsed.root.length - (parsed.root.endsWith(path.sep) ? 1 : 0));
    const { roaming, local } = ensureRuntimeAppDataDirs(runtimeHome);
    env.APPDATA = roaming;
    env.LOCALAPPDATA = local;
  }

  return env;
}
