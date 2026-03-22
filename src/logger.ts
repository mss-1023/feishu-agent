/**
 * 全局日志 — 基于 pino 的结构化日志实例。
 * 包含日志脱敏功能，自动遮蔽敏感字段和 API 密钥模式。
 */
import crypto from 'node:crypto';
import pino from 'pino';

/** 敏感字段名匹配模式 */
const SENSITIVE_FIELD_PATTERN = /key|secret|token|password|authorization/i;

/** API 密钥前缀模式 */
const API_KEY_PATTERNS: RegExp[] = [
  /^sk-/,
  /^xoxb-/,
  /^ghp_/,
  /^gho_/,
  /^Bearer /,
];

/**
 * 检测并遮蔽符合已知 API 密钥模式的字符串。
 * 遮蔽格式：保留前 4 字符 + `***` + 长度信息。
 * 若不匹配任何模式，返回原值。
 */
export function maskSecrets(value: string): string {
  for (const pattern of API_KEY_PATTERNS) {
    if (pattern.test(value)) {
      const prefix = value.slice(0, 4);
      return `${prefix}***[len=${value.length}]`;
    }
  }
  return value;
}

/**
 * 遮蔽单个敏感值。
 * 对字符串：保留前 4 字符 + `***` + 长度信息。
 * 对非字符串：返回 `[REDACTED]`。
 */
function maskValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length <= 4) {
      return `***[len=${value.length}]`;
    }
    const prefix = value.slice(0, 4);
    return `${prefix}***[len=${value.length}]`;
  }
  return '[REDACTED]';
}

/**
 * 递归遍历对象，对字段名匹配敏感模式的值进行遮蔽，
 * 同时对所有字符串值检测 API 密钥模式并遮蔽。
 */
export function sanitizeLogData(data: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  return sanitizeRecursive(data, seen) as Record<string, unknown>;
}

function sanitizeRecursive(value: unknown, seen: WeakSet<object>, fieldName?: string): unknown {
  // Handle sensitive field names — mask the entire value
  if (fieldName && SENSITIVE_FIELD_PATTERN.test(fieldName)) {
    return maskValue(value);
  }

  // Handle strings — check for API key patterns
  if (typeof value === 'string') {
    return maskSecrets(value);
  }

  // Handle arrays
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => sanitizeRecursive(item, seen));
  }

  // Handle objects
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeRecursive(v, seen, k);
    }
    return result;
  }

  // Primitives pass through
  return value;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
          },
        },
  serializers: {
    // Auto-sanitize any object passed under these common keys
    req: (value: unknown) =>
      value && typeof value === 'object'
        ? sanitizeLogData(value as Record<string, unknown>)
        : value,
    res: (value: unknown) =>
      value && typeof value === 'object'
        ? sanitizeLogData(value as Record<string, unknown>)
        : value,
    err: (value: unknown) =>
      value && typeof value === 'object'
        ? sanitizeLogData(value as Record<string, unknown>)
        : value,
  },
  hooks: {
    logMethod(this: pino.Logger, inputArgs: Parameters<pino.LogFn>, method: pino.LogFn, _level: number) {
      // Sanitize the merging object (first arg when it's an object)
      if (inputArgs.length >= 2 && typeof inputArgs[0] === 'object' && inputArgs[0] !== null) {
        inputArgs[0] = sanitizeLogData(inputArgs[0] as Record<string, unknown>);
      }
      // Sanitize string messages for API key patterns
      const msgIndex = typeof inputArgs[0] === 'string' ? 0 : 1;
      if (typeof inputArgs[msgIndex] === 'string') {
        (inputArgs as unknown[])[msgIndex] = maskSecrets(inputArgs[msgIndex] as string);
      }
      method.apply(this, inputArgs);
    },
  },
});

/**
 * 创建带 Correlation ID 的子 logger。
 * 使用 Pino 的 `logger.child()` 机制，将 correlationId 自动附加到所有日志条目。
 *
 * @param correlationId 可选的关联 ID。若未提供，则使用 `crypto.randomUUID()` 前 8 位自动生成。
 * @returns 带有 correlationId 上下文的 Pino child logger
 */
export function createCorrelationLogger(correlationId?: string): pino.Logger {
  const id = correlationId ?? crypto.randomUUID().slice(0, 8);
  return logger.child({ correlationId: id });
}
