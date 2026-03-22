/**
 * Nacos 远程配置加载 — 从 Nacos 配置中心拉取配置，支持 properties/JSON/YAML 格式。
 */
import { NacosConfigClient } from 'nacos';
import YAML from 'yaml';

import { logger } from '../logger.js';

export function flattenObject(value: unknown, prefix = '', out: Record<string, string> = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenObject(child, nextKey, out);
    } else {
      out[nextKey] = child == null ? '' : String(child);
    }
  }
  return out;
}

function getNacosConnParam(
  envKey: string,
  propKey: string,
  props: Map<string, string>,
  fallback = '',
) {
  return process.env[envKey] || props.get(propKey) || fallback;
}

/**
 * 解析 Nacos 配置内容（properties/JSON/YAML 格式）为扁平化键值对。
 */
function parseNacosContent(content: string, configType: string): Record<string, string> {
  const trimmed = String(content).trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith('{')) {
    return flattenObject(JSON.parse(trimmed));
  }
  if (configType === 'yaml') {
    return flattenObject(YAML.parse(trimmed));
  }

  const out: Record<string, string> = {};
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const index = line.indexOf('=');
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

export async function loadNacosConfig(
  props: Map<string, string>,
  hasEnvLocal: boolean,
): Promise<Record<string, string>> {
  if (hasEnvLocal) {
    logger.info('Local dev mode: Nacos loading skipped');
    return {};
  }

  const serverAddr = getNacosConnParam('NACOS_SERVER', 'nacos.config.server-addr', props);
  const namespace = getNacosConnParam('NACOS_NAMESPACE', 'nacos.config.namespace', props);
  const username = getNacosConnParam('NACOS_USERNAME', 'nacos.config.username', props);
  const password = getNacosConnParam('NACOS_PASSWORD', 'nacos.config.password', props);
  const group = getNacosConnParam('NACOS_GROUP', 'nacos.config.group', props, 'DEFAULT_GROUP');
  const dataIdsRaw = getNacosConnParam(
    'NACOS_DATA_ID',
    'nacos.config.data-ids',
    props,
    'feishu-claude-agent',
  );
  const dataId = dataIdsRaw.split(',')[0]?.trim();
  const configType = getNacosConnParam('NACOS_CONFIG_TYPE', 'nacos.config.type', props, 'properties');

  if (!serverAddr || !namespace || !dataId) {
    logger.info('Nacos not configured, skipping');
    return {};
  }

  try {
    const client = new NacosConfigClient({
      serverAddr,
      namespace,
      username,
      password,
    } as any);
    const content = await client.getConfig(dataId, group);
    if (!content) {
      logger.info({ dataId, group }, 'Nacos config not found');
      return {};
    }

    const result = parseNacosContent(content, configType);
    logger.info({ dataId, group, keys: Object.keys(result).length }, 'Loaded Nacos config');
    return result;
  } catch (error) {
    logger.warn({ error }, 'Failed to load Nacos config, falling back to env/properties');
    return {};
  }
}

/**
 * 订阅 Nacos 配置变更，收到变更时解析内容并调用 onUpdate 回调。
 * 在本地开发模式（hasEnvLocal）下跳过订阅。
 */
export async function subscribeNacosConfig(
  props: Map<string, string>,
  hasEnvLocal: boolean,
  onUpdate: (newConfig: Record<string, string>) => void,
): Promise<void> {
  if (hasEnvLocal) {
    logger.info('Local dev mode: Nacos subscription skipped');
    return;
  }

  const serverAddr = getNacosConnParam('NACOS_SERVER', 'nacos.config.server-addr', props);
  const namespace = getNacosConnParam('NACOS_NAMESPACE', 'nacos.config.namespace', props);
  const username = getNacosConnParam('NACOS_USERNAME', 'nacos.config.username', props);
  const password = getNacosConnParam('NACOS_PASSWORD', 'nacos.config.password', props);
  const group = getNacosConnParam('NACOS_GROUP', 'nacos.config.group', props, 'DEFAULT_GROUP');
  const dataIdsRaw = getNacosConnParam(
    'NACOS_DATA_ID',
    'nacos.config.data-ids',
    props,
    'feishu-claude-agent',
  );
  const dataId = dataIdsRaw.split(',')[0]?.trim();
  const configType = getNacosConnParam('NACOS_CONFIG_TYPE', 'nacos.config.type', props, 'properties');

  if (!serverAddr || !namespace || !dataId) {
    logger.info('Nacos not configured, subscription skipped');
    return;
  }

  try {
    const client = new NacosConfigClient({
      serverAddr,
      namespace,
      username,
      password,
    } as any);

    client.subscribe({ dataId, group }, (content: string) => {
      try {
        const parsed = parseNacosContent(content, configType);
        logger.info({ dataId, group, keys: Object.keys(parsed).length }, 'Nacos config changed');
        onUpdate(parsed);
      } catch (error) {
        logger.error({ error, dataId, group }, 'Failed to parse Nacos config update');
      }
    });

    logger.info({ dataId, group }, 'Nacos config subscription registered');
  } catch (error) {
    logger.warn({ error }, 'Failed to subscribe Nacos config');
  }
}
