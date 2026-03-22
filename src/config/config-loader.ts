/**
 * 本地配置加载 — 解析 .env.local 和 application.properties，提供统一取值函数 getValue。
 */
import fs from 'node:fs';
import path from 'node:path';

import { config as loadDotEnv } from 'dotenv';

import { logger } from '../logger.js';

const projectDir = process.cwd();

const envLocalPath = path.join(projectDir, '.env.local');
export const hasEnvLocal = fs.existsSync(envLocalPath);
if (hasEnvLocal) {
  loadDotEnv({ path: envLocalPath, override: false });
  logger.info({ path: envLocalPath }, 'Loaded .env.local');
}

const propsPath = path.join(projectDir, 'application.properties');
export const props = new Map<string, string>();
if (fs.existsSync(propsPath)) {
  const content = fs.readFileSync(propsPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const index = line.indexOf('=');
    props.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
}

export function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value == null || value === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function getValue(key: string, fallback = '', nacosConfig: Record<string, string>): string {
  const envValue = process.env[key];
  if (envValue != null && envValue !== '') {
    return envValue;
  }
  if (nacosConfig[key] != null && nacosConfig[key] !== '') {
    return nacosConfig[key];
  }
  for (const [nacosKey, nacosValue] of Object.entries(nacosConfig)) {
    if (nacosKey.endsWith(`.${key}`) && nacosValue !== '') {
      return nacosValue;
    }
  }
  const propValue = props.get(key);
  if (propValue != null && propValue !== '') {
    return propValue;
  }
  return fallback;
}
