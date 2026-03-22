/**
 * 路径工具 — 路径规范化、目录包含判断、路径去重等通用函数。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function normalizePath(value: string, baseDir = process.cwd()) {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return null;
  }

  const expanded = trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(2))
    : trimmed;
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
  return path.resolve(absolute);
}

export function resolveRealPath(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') {
      return null;
    }
    return null;
  }
}

export function isWithinRoot(targetPath: string, rootPath: string) {
  try {
    const realTarget = resolveRealPath(targetPath);
    const realRoot = resolveRealPath(rootPath);
    if (realTarget === null || realRoot === null) {
      return false;
    }
    const relative = path.relative(realRoot, realTarget);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths));
}
