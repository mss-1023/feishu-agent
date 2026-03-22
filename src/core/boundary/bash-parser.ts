/**
 * Bash 命令解析 — 对 Bash 命令进行分词，提取其中涉及的文件路径。
 */
import { normalizePath } from './path-utils.js';
import { CONSTANTS } from '../../config/config.js';

export const SINGLE_PATH_COMMANDS = new Set([
  'cd',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'ls',
  'tree',
  'stat',
  'wc',
  'touch',
  'mkdir',
  'rm',
  'rmdir',
  'cp',
  'mv',
  'ln',
  'tar',
  'unzip',
  'zip',
  'chmod',
  'chown',
  'sed',
  'awk',
  'tee',
  'rg',
  'grep',
  'find',
  'code',
]);

export const GIT_PATH_SUBCOMMANDS = new Set([
  'add',
  'checkout',
  'clean',
  'diff',
  'mv',
  'reset',
  'restore',
  'rm',
  'status',
  'switch',
]);

export function tokenizeCommand(command: string) {
  return command.match(/"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g) || [];
}

export function stripQuotes(token: string) {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'")) ||
    (token.startsWith('`') && token.endsWith('`'))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

export function looksLikePath(token: string) {
  if (!token || token.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
    return false;
  }
  return (
    token === '.' ||
    token === '..' ||
    token.startsWith('/') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('~/') ||
    /^[A-Za-z]:[\\/]/.test(token) ||
    token.includes('/') ||
    token.includes('\\')
  );
}

/**
 * 从 --key=value 格式参数中提取路径值。
 * 当 value 部分通过 looksLikePath() 检查时，返回规范化后的路径；否则返回 null。
 */
export function extractKeyValuePaths(token: string, workspaceDir: string): string | null {
  const eqIndex = token.indexOf('=');
  if (eqIndex === -1) return null;

  const key = token.slice(0, eqIndex);
  // Must start with -- (long option format)
  if (!key.startsWith('--')) return null;

  const value = token.slice(eqIndex + 1);
  if (!value || !looksLikePath(value)) return null;

  return normalizePath(value, workspaceDir);
}

/**
 * 从命令替换语法 $(...) 和反引号 `...` 中递归提取路径。
 */
export function extractCommandSubstitutionPaths(
  command: string,
  workspaceDir: string,
  depth = 0,
): string[] {
  if (depth >= CONSTANTS.COMMAND_SUBSTITUTION_MAX_DEPTH) {
    return [];
  }

  const paths: string[] = [];

  // Match $(...) command substitutions
  const dollarParenRegex = /\$\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = dollarParenRegex.exec(command)) !== null) {
    const innerCommand = match[1];
    const innerPaths = extractBashPaths(innerCommand, workspaceDir, depth + 1);
    paths.push(...innerPaths);
  }

  // Match backtick `...` command substitutions
  const backtickRegex = /`([^`]+)`/g;
  while ((match = backtickRegex.exec(command)) !== null) {
    const innerCommand = match[1];
    const innerPaths = extractBashPaths(innerCommand, workspaceDir, depth + 1);
    paths.push(...innerPaths);
  }

  return paths;
}

export function extractBashPaths(command: string, workspaceDir: string, depth = 0) {
  const tokens = tokenizeCommand(command).map(stripQuotes);
  const found = new Set<string>();
  let commandName = '';
  let gitSubcommand = '';
  let expectPathFor = '';

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (['&&', '||', ';', '|'].includes(token)) {
      commandName = '';
      gitSubcommand = '';
      expectPathFor = '';
      continue;
    }

    if (!commandName && !token.startsWith('-')) {
      commandName = token;
      gitSubcommand = '';
      expectPathFor = SINGLE_PATH_COMMANDS.has(commandName) ? commandName : '';
      continue;
    }

    if (commandName === 'git' && !gitSubcommand && !token.startsWith('-')) {
      gitSubcommand = token;
      if (GIT_PATH_SUBCOMMANDS.has(gitSubcommand)) {
        expectPathFor = `${commandName}:${gitSubcommand}`;
      }
      continue;
    }

    if (token === '--') {
      expectPathFor = 'path-after-double-dash';
      continue;
    }

    if (token === '-C' || token === '--cwd' || token === '--directory' || token === '--prefix') {
      expectPathFor = token;
      continue;
    }

    if (['>', '>>', '1>', '2>', '&>'].includes(token)) {
      expectPathFor = token;
      continue;
    }

    if (expectPathFor && !token.startsWith('-')) {
      const normalized = normalizePath(token, workspaceDir);
      if (normalized) {
        found.add(normalized);
      }
      if (!expectPathFor.startsWith('path-after-double-dash')) {
        expectPathFor = SINGLE_PATH_COMMANDS.has(commandName) ? commandName : '';
      }
      continue;
    }

    // Check for --key=value format path extraction
    if (token.startsWith('--') && token.includes('=')) {
      const kvPath = extractKeyValuePaths(token, workspaceDir);
      if (kvPath) {
        found.add(kvPath);
      }
      continue;
    }

    if (looksLikePath(token)) {
      const normalized = normalizePath(token, workspaceDir);
      if (normalized) {
        found.add(normalized);
      }
    }
  }

  // Extract paths from command substitutions recursively
  for (const p of extractCommandSubstitutionPaths(command, workspaceDir, depth)) {
    found.add(p);
  }

  return Array.from(found);
}
