/**
 * 飞书卡片动作处理 — 处理用户点击飞书交互卡片（权限审批、会话切换等）的回调。
 */
import type { InteractiveCard } from '@larksuiteoapi/node-sdk';

import { buildPermissionResolvedCard, buildSessionListCard } from '../feishu/cards.js';
import { feishuCardActionSchema } from '../feishu/schemas.js';
import { logger } from '../logger.js';
import type { SessionManager } from './session/session-manager.js';

export async function handleCardAction(
  actionData: unknown,
  sessionManager: SessionManager,
): Promise<Record<string, unknown>> {
  const parseResult = feishuCardActionSchema.safeParse(actionData);
  if (!parseResult.success) {
    logger.warn(
      { errors: parseResult.error.issues },
      'card action failed schema validation',
    );
    return { toast: { type: 'warning', content: 'Invalid action payload.' } };
  }
  const validData = parseResult.data;
  const actionValue = validData.action.value;
  let value: Record<string, string>;
  try {
    value =
      typeof actionValue === 'string' ? JSON.parse(actionValue || '{}') : (actionValue as Record<string, string>) || {};
  } catch (error) {
    logger.warn({ error, actionValue }, 'failed to parse card action payload');
    return { toast: { type: 'warning', content: 'Invalid action payload.' } };
  }
  const actionType = value.action_type || '';
  const sessionKey = value.session_key || '';
  const requestId = value.request_id || '';
  const operatorOpenId = validData.operator?.open_id;

  if (
    actionType === 'permission_approve' ||
    actionType === 'permission_deny' ||
    actionType === 'permission_skip_10min'
  ) {
    const session = sessionManager.getSession(sessionKey);
    if (!session) {
      return { toast: { type: 'warning', content: 'Session not found.' } };
    }
    if (actionType === 'permission_skip_10min') {
      session.setSmartBypass(600);
    }
    const decision = actionType === 'permission_deny' ? 'deny' : 'allow';
    const resolved = session.resolvePermission(requestId, decision);
    if (!resolved) {
      return { toast: { type: 'info', content: 'Request already handled.' } };
    }
    return {
      toast: {
        type: decision === 'allow' ? 'success' : 'info',
        content:
          actionType === 'permission_skip_10min'
            ? 'Approved, safe operations will auto-pass for 10 minutes.'
            : decision === 'allow'
              ? 'Approved.'
              : 'Denied.',
      },
      card: buildPermissionResolvedCard({
        toolName: resolved.toolName,
        toolInput: resolved.toolInput,
        decision,
        operatorOpenId,
      }) as InteractiveCard,
    };
  }

  if (actionType === 'session_switch') {
    const group = sessionManager.getGroup(sessionKey);
    if (!group) {
      return { toast: { type: 'warning', content: 'Session group not found.' } };
    }
    const session = group.switchSession(value.session_name || '');
    if (!session) {
      return { toast: { type: 'warning', content: 'Session not found.' } };
    }
    return {
      toast: { type: 'success', content: `Switched to ${value.session_name}.` },
      card: buildSessionListCard(sessionKey, group.listSessions()),
    };
  }

  if (actionType === 'session_delete') {
    const group = sessionManager.getGroup(sessionKey);
    if (!group) {
      return { toast: { type: 'warning', content: 'Session group not found.' } };
    }
    const result = group.deleteSession(value.session_name || '');
    if (!result.ok) {
      return { toast: { type: 'warning', content: result.reason } };
    }
    return {
      toast: { type: 'success', content: `Deleted ${value.session_name}.` },
      card: buildSessionListCard(sessionKey, group.listSessions()),
    };
  }

  return { toast: { type: 'info', content: 'Unknown action.' } };
}
