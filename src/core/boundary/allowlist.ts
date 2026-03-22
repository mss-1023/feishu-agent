/**
 * 白名单与边界评估 — 解析路径白名单，评估工具调用是否在运行时边界内。
 */
import fs from 'node:fs';
import path from 'node:path';

import { settings } from '../../config/config.js';
import { logger } from '../../logger.js';
import { extractBashPaths } from './bash-parser.js';
import { isWithinRoot, normalizePath, uniquePaths } from './path-utils.js';

const PROJECT_ROOT = path.resolve(process.cwd());

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const TOOL_PATH_KEYS = ['file_path', 'path', 'notebook_path', 'cwd'];
const TOOL_PATH_ARRAY_KEYS = ['paths'];

const BLOCKED_BASH_PATTERNS = [
  /\bdd\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bfdisk\b/i,
  /\bparted\b/i,
  /\bsfdisk\b/i,
  /\bcfdisk\b/i,
  /\bwipefs\b/i,
  /\bshred\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\binit\s+[06]\b/i,
  /\bsystemctl\s+(?:stop|restart|reboot|poweroff|halt|disable|mask)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f\b/i,
  /\bgit\s+push\b.*--force(?:-with-lease)?\b/i,
];

const MUTATING_BASH_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\btouch\b/i,
  /\bmkdir\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\btee\b/i,
  /\bsed\b.*\s-i(?:\s|$)/i,
  /\bperl\b.*\s-i(?:\s|$)/i,
  /\bpython(?:3)?\b.*(?:Path|open)\(/i,
  /\bnode\b.*writeFile/i,
  /\bnpm\b\s+(?:install|update|uninstall|run)\b/i,
  /\bpnpm\b\s+(?:add|remove|install|update|run)\b/i,
  /\byarn\b\s+(?:add|remove|install|up|run)\b/i,
  /\bpip(?:3)?\b\s+(?:install|uninstall)\b/i,
  /\bgit\s+(?:add|apply|am|checkout|cherry-pick|clean|commit|merge|mv|rebase|restore|revert|rm|stash|switch)\b/i,
  /(?:^|[^>])>(?!>)/,
  />>/,
];

export interface BoundaryDecision {
  allowed: boolean;
  reason?: string;
  mutating: boolean;
  requestedPaths: string[];
  allowedRoots: string[];
}

function parseInlineAllowlist(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch (error) {
      logger.warn({ error }, 'failed to parse HOST_PATH_ALLOWLIST as json');
    }
  }

  return trimmed
    .split(/[;\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAllowlistFile(filePath: string) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }

    if (parsed && typeof parsed === 'object') {
      const objectValue = parsed as Record<string, unknown>;
      const candidates = objectValue.paths || objectValue.allowlist || objectValue.mounts;
      if (Array.isArray(candidates)) {
        return candidates.filter((item): item is string => typeof item === 'string');
      }
    }
  } catch (error) {
    logger.warn({ error, filePath }, 'failed to parse allowlist file');
  }

  return [];
}

function resolveAllowedRoots(workspaceDir: string) {
  const configured = [
    ...parseInlineAllowlist(settings.hostPathAllowlist),
    ...parseAllowlistFile(settings.hostPathAllowlistFile),
  ];

  return uniquePaths(
    [workspaceDir, ...configured]
      .map((item) => normalizePath(item))
      .filter((item): item is string => Boolean(item)),
  );
}

function extractToolPaths(toolName: string, input: Record<string, unknown>, workspaceDir: string) {
  const values: string[] = [];

  for (const key of TOOL_PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string') {
      values.push(value);
    }
  }

  for (const key of TOOL_PATH_ARRAY_KEYS) {
    const value = input[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          values.push(item);
        }
      }
    }
  }

  if ((toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') && values.length === 0) {
    values.push(workspaceDir);
  }

  return uniquePaths(
    values
      .map((item) => normalizePath(item, workspaceDir))
      .filter((item): item is string => Boolean(item)),
  );
}

function describeBoundaryDeny(targetPath: string, allowedRoots: string[]) {
  return [
    `Path is outside runtime boundary: ${targetPath}`,
    `Allowed roots: ${allowedRoots.join(', ')}`,
  ].join('\n');
}

function checkPathsAgainstBoundary(requestedPaths: string[], allowedRoots: string[]) {
  for (const requestedPath of requestedPaths) {
    if (settings.protectProjectCode && isWithinRoot(requestedPath, PROJECT_ROOT)) {
      return {
        allowed: false,
        reason: `Project source is protected and cannot be changed by the bot: ${requestedPath}`,
      };
    }

    const allowed = allowedRoots.some((root) => isWithinRoot(requestedPath, root));
    if (!allowed) {
      return {
        allowed: false,
        reason: describeBoundaryDeny(requestedPath, allowedRoots),
      };
    }
  }

  return { allowed: true as const };
}

export function getRuntimeBoundaryRoots(workspaceDir: string) {
  return resolveAllowedRoots(workspaceDir);
}

export function evaluateToolBoundary(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir: string,
): BoundaryDecision {
  const allowedRoots = resolveAllowedRoots(workspaceDir);

  if (!settings.runtimeBoundaryEnabled || toolName.startsWith('mcp__')) {
    return {
      allowed: true,
      mutating: WRITE_TOOLS.has(toolName),
      requestedPaths: [],
      allowedRoots,
    };
  }

  if (toolName === 'Bash') {
    const command =
      typeof input.command === 'string' ? input.command : JSON.stringify(input);

    for (const pattern of BLOCKED_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `Command is blocked by runtime policy: ${command}`,
          mutating: true,
          requestedPaths: [],
          allowedRoots,
        };
      }
    }

    const requestedPaths = extractBashPaths(command, workspaceDir);
    const pathCheck = checkPathsAgainstBoundary(requestedPaths, allowedRoots);
    if (!pathCheck.allowed) {
      return {
        allowed: false,
        reason: pathCheck.reason,
        mutating: true,
        requestedPaths,
        allowedRoots,
      };
    }

    const mutating = MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
    return {
      allowed: true,
      mutating,
      requestedPaths,
      allowedRoots,
    };
  }

  if (!READ_ONLY_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName)) {
    return {
      allowed: true,
      mutating: false,
      requestedPaths: [],
      allowedRoots,
    };
  }

  const requestedPaths = extractToolPaths(toolName, input, workspaceDir);
  const pathCheck = checkPathsAgainstBoundary(requestedPaths, allowedRoots);
  if (!pathCheck.allowed) {
    return {
      allowed: false,
      reason: pathCheck.reason,
      mutating: WRITE_TOOLS.has(toolName),
      requestedPaths,
      allowedRoots,
    };
  }

  return {
    allowed: true,
    mutating: WRITE_TOOLS.has(toolName),
    requestedPaths,
    allowedRoots,
  };
}
