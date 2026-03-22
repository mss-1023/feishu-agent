/**
 * 斜杠命令路由 — 处理 /help、/list、/reset、/restart 等用户命令和 bypass 模式切换。
 */
import { spawn } from 'node:child_process';

import { settings } from '../../config/config.js';
import {
  buildHelpCard,
  buildSessionListCard,
  buildSkillSuggestionRecordedCard,
  buildSkillSuggestionsListCard,
} from '../../feishu/cards.js';
import type { FeishuSender } from '../../feishu/sender.js';
import { logger } from '../../logger.js';
import type { SessionManager } from '../session/session-manager.js';
import { addSkillSuggestion, listSkillSuggestions } from '../skills/skills.js';

const EXIT_BYPASS_RE = /(退出|关闭|结束)(bypass|旁路)?模式|恢复正常/i;

export interface CommandResult {
  handled: boolean;
}

function scheduleRestart() {
  setTimeout(() => {
    spawn(settings.restartCommand, {
      cwd: process.cwd(),
      shell: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
  }, 1000);
}

export async function tryHandleCommand(input: {
  text: string;
  messageId: string;
  sessionKey: string;
  chatId: string;
  sender: FeishuSender;
  sessionManager: SessionManager;
}): Promise<CommandResult> {
  const { text, messageId, sessionKey, chatId, sender, sessionManager } = input;
  const lower = text.toLowerCase();

  if (lower === '/help') {
    logger.info({ messageId, sessionKey, command: '/help' }, 'handling command');
    await sender.sendCard(chatId, buildHelpCard());
    return { handled: true };
  }
  if (lower === '/list') {
    logger.info({ messageId, sessionKey, command: '/list' }, 'handling command');
    const group = sessionManager.getOrCreateGroup(sessionKey, chatId);
    group.ensureDefault();
    await sender.sendCard(chatId, buildSessionListCard(sessionKey, group.listSessions()));
    return { handled: true };
  }
  if (lower === '/reset') {
    logger.info({ messageId, sessionKey, command: '/reset' }, 'handling command');
    const reset = sessionManager.resetSession(sessionKey);
    await sender.sendText(chatId, reset ? '会话已重置。' : '当前没有活动会话。');
    return { handled: true };
  }
  if (lower === '/restart') {
    logger.info({ messageId, sessionKey, command: '/restart' }, 'handling command');
    sessionManager.save();
    await sender.sendText(chatId, '状态已保存，服务将在 1 秒后重启。');
    scheduleRestart();
    return { handled: true };
  }
  if (lower.startsWith('/new')) {
    logger.info({ messageId, sessionKey, command: '/new' }, 'handling command');
    const name = text.slice(4).trim() || undefined;
    const group = sessionManager.getOrCreateGroup(sessionKey, chatId);
    const created = group.createSession(name, true);
    await sender.sendText(
      chatId,
      created ? `已创建并切换到会话 '${created.name}'。` : '会话名称已存在。',
    );
    return { handled: true };
  }
  if (lower.startsWith('/switch')) {
    logger.info({ messageId, sessionKey, command: '/switch' }, 'handling command');
    const name = text.slice(7).trim();
    const group = sessionManager.getGroup(sessionKey);
    const switched = name ? group?.switchSession(name) : null;
    await sender.sendText(chatId, switched ? `已切换到 '${name}'。` : '会话不存在。');
    return { handled: true };
  }
  if (lower.startsWith('/delete')) {
    logger.info({ messageId, sessionKey, command: '/delete' }, 'handling command');
    const name = text.slice(7).trim();
    const group = sessionManager.getGroup(sessionKey);
    const result = name ? group?.deleteSession(name) : null;
    await sender.sendText(chatId, result?.ok ? `已删除 '${name}'。` : result?.reason || '会话不存在。');
    return { handled: true };
  }
  if (lower.startsWith('/rename')) {
    logger.info({ messageId, sessionKey, command: '/rename' }, 'handling command');
    const newName = text.slice(7).trim();
    const group = sessionManager.getGroup(sessionKey);
    const result = newName ? group?.renameActiveSession(newName) : null;
    await sender.sendText(
      chatId,
      result?.ok ? `已将 '${result.oldName}' 重命名为 '${newName}'。` : result?.reason || '重命名失败。',
    );
    return { handled: true };
  }
  if (lower === '/skill优化列表') {
    logger.info({ messageId, sessionKey, command: '/skill优化列表' }, 'handling command');
    const suggestions = listSkillSuggestions('pending').map((item) => ({
      id: item.id,
      skillName: item.skillName,
      description: item.description,
      timestamp: item.timestamp,
    }));
    await sender.sendCard(chatId, buildSkillSuggestionsListCard(suggestions));
    return { handled: true };
  }
  if (lower.startsWith('/skill优化')) {
    logger.info({ messageId, sessionKey, command: '/skill优化' }, 'handling command');
    const body = text.slice('/skill优化'.length).trim();
    if (!body) {
      await sender.sendText(chatId, '用法: /skill优化 [skill名] 优化描述');
      return { handled: true };
    }
    const parts = body.split(/\s+/, 2);
    let skillName = '';
    let description = body;
    if (parts.length === 2 && /^[a-zA-Z][\w-]+$/.test(parts[0])) {
      [skillName, description] = parts;
    }
    const suggestion = addSkillSuggestion(skillName, description.trim(), sessionKey);
    const pendingCount = listSkillSuggestions('pending').length;
    await sender.sendCard(
      chatId,
      buildSkillSuggestionRecordedCard({
        id: suggestion.id,
        skillName: suggestion.skillName,
        description: suggestion.description,
        timestamp: suggestion.timestamp,
        pendingCount,
      }),
    );
    return { handled: true };
  }
  if (text === '我要开启bypass模式') {
    logger.info({ messageId, sessionKey, command: 'bypass:on' }, 'handling command');
    const session = sessionManager.getOrCreateSession(sessionKey, chatId);
    session?.setBypassMode(true, 300);
    await sender.sendText(chatId, 'Bypass 模式已开启，5 分钟内所有工具调用自动放行。');
    return { handled: true };
  }
  if (EXIT_BYPASS_RE.test(text)) {
    logger.info({ messageId, sessionKey, command: 'bypass:off' }, 'handling command');
    const session = sessionManager.getSession(sessionKey);
    if (session?.isBypassActive()) {
      session.setBypassMode(false);
      await sender.sendText(chatId, 'Bypass 模式已关闭。');
      return { handled: true };
    }
  }

  return { handled: false };
}
