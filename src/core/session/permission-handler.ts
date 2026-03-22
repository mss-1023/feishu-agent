/**
 * 权限决策 — 评估工具调用权限，依次检查运行时边界、bypass、自动放行、智能 bypass 和用户审批。
 */
import { randomUUID } from 'node:crypto';

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import { logger } from '../../logger.js';
import type { PendingPermissionRecord } from '../../types.js';
import { buildPermissionCard } from '../../feishu/cards.js';
import type { FeishuSender } from '../../feishu/sender.js';
import { evaluateToolBoundary } from '../boundary/allowlist.js';

export const AUTO_ALLOW_TOOLS = new Set([
  'WebSearch',
  'WebFetch',
  'Skill',
  'TodoWrite',
]);

export const BOUNDARY_AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);

/** Permission handling context from the session. */
export interface PermissionContext {
  sessionKey: string;
  workspaceDir: string;
  isBypassActive: () => boolean;
  isSmartBypassActive: () => boolean;
  currentCardMessageId: string | null;
  currentRootMessageId: string | null;
  sender: FeishuSender;
}

/** Callbacks for registering pending permission requests. */
export interface PermissionCallbacks {
  registerPending: (
    requestId: string,
    record: PendingPermissionRecord,
    resolve: (decision: 'allow' | 'deny') => void,
  ) => void;
}

/**
 * Evaluate tool permission through the full decision chain:
 * runtime boundary → bypass → auto-allow → smart bypass → user approval
 */
export async function evaluatePermission(
  toolName: string,
  input: Record<string, unknown>,
  options: { title?: string; description?: string; toolUseID: string },
  context: PermissionContext,
  callbacks: PermissionCallbacks,
): Promise<PermissionResult> {
  const boundary = evaluateToolBoundary(toolName, input, context.workspaceDir);
  if (!boundary.allowed) {
    logger.warn(
      {
        sessionKey: context.sessionKey,
        toolName,
        reason: boundary.reason || 'Denied by runtime boundary.',
      },
      'tool denied by runtime boundary',
    );
    const replyTo = context.currentCardMessageId || context.currentRootMessageId;
    if (replyTo && boundary.reason) {
      await context.sender.replyText(replyTo, `运行边界已拒绝 ${toolName}:\n${boundary.reason}`, true);
    }
    return {
      behavior: 'deny',
      message: boundary.reason || 'Denied by runtime boundary.',
      toolUseID: options.toolUseID,
    };
  }

  if (context.isBypassActive()) {
    logger.info({ sessionKey: context.sessionKey, toolName }, 'tool allowed by bypass mode');
    return { behavior: 'allow', toolUseID: options.toolUseID };
  }

  if (BOUNDARY_AUTO_ALLOW_TOOLS.has(toolName)) {
    logger.debug({ sessionKey: context.sessionKey, toolName }, 'tool auto allowed by boundary allowlist');
    return { behavior: 'allow', toolUseID: options.toolUseID };
  }

  if (AUTO_ALLOW_TOOLS.has(toolName) || toolName.startsWith('mcp__')) {
    logger.info({ sessionKey: context.sessionKey, toolName }, 'tool auto allowed');
    return { behavior: 'allow', toolUseID: options.toolUseID };
  }

  const dangerous = boundary.mutating;

  if (context.isSmartBypassActive() && !dangerous) {
    logger.info({ sessionKey: context.sessionKey, toolName }, 'tool allowed by smart bypass');
    return { behavior: 'allow', toolUseID: options.toolUseID };
  }

  const requestId = randomUUID();
  const record: PendingPermissionRecord = {
    requestId,
    toolName,
    toolInput: input,
    title: options.title,
    description: options.description,
  };

  const replyTo = context.currentCardMessageId || context.currentRootMessageId;
  if (replyTo) {
    logger.info(
      {
        sessionKey: context.sessionKey,
        toolName,
        requestId,
        dangerous,
      },
      'requesting tool permission from user',
    );
    await context.sender.replyCard(
      replyTo,
      buildPermissionCard({
        toolName,
        toolInput: input,
        sessionKey: context.sessionKey,
        requestId,
        title:
          options.title ||
          (dangerous
            ? `Dangerous operation requested: ${toolName}`
            : undefined),
        description: options.description,
      }),
      true,
    );
  }

  const decision = await new Promise<'allow' | 'deny'>((resolve) => {
    callbacks.registerPending(requestId, record, resolve);
  });

  if (decision === 'allow') {
    logger.info({ sessionKey: context.sessionKey, toolName, requestId }, 'tool permission allowed by user');
    return { behavior: 'allow', toolUseID: options.toolUseID };
  }
  logger.info({ sessionKey: context.sessionKey, toolName, requestId }, 'tool permission denied by user');
  return {
    behavior: 'deny',
    message: 'User denied the operation.',
    toolUseID: options.toolUseID,
  };
}
