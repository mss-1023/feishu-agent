/**
 * 消息处理主流程 — 接收飞书消息，协调命令路由、附件提取和 Claude 会话交互。
 */
import path from 'node:path';

import { settings } from '../../config/config.js';
import type { FeishuSender } from '../../feishu/sender.js';
import { feishuMessageEventSchema, type FeishuMessageEvent } from '../../feishu/schemas.js';
import { logger, createCorrelationLogger } from '../../logger.js';
import { parseMessageJson, extractAttachments, extractParentAttachments } from './attachment-extractor.js';
import { tryHandleCommand } from './command-router.js';
import { TTLDedup } from './dedup.js';
import { buildPrompt } from './prompt.js';
import type { SessionManager } from '../session/session-manager.js';

const dedup = new TTLDedup();
const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'post', 'image', 'file']);
const PLAN_MODE_RE = /进入(规划|计划|plan)模式/i;

function summarizeText(text: string, maxLength = 80) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function extractText(content: string | undefined) {
  const parsed = parseMessageJson(content);
  return typeof parsed.text === 'string' ? parsed.text.trim() : '';
}

function stripMentionTokens(text: string) {
  return text.replace(/@_user_\d+\s*/g, '').trim();
}

async function shouldHandleGroupMessage(message: FeishuMessageEvent['message'], sender: FeishuSender) {
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const botOpenId = await sender.getBotOpenId();
  if (botOpenId) {
    return mentions.some((mention) => mention?.id?.open_id === botOpenId);
  }
  const rawText = extractText(message.content);
  return /@_user_\d+/.test(rawText);
}

export async function handleIncomingMessage(
  data: unknown,
  sessionManager: SessionManager,
  sender: FeishuSender,
) {
  // Generate correlation ID and child logger at the entry point for full-chain tracing
  const log = createCorrelationLogger();

  const parseResult = feishuMessageEventSchema.safeParse(data);
  if (!parseResult.success) {
    log.warn(
      { errors: parseResult.error.issues },
      'incoming event failed schema validation, skipping',
    );
    return;
  }
  const validData = parseResult.data;
  const message = validData.message;
  const senderInfo = validData.sender;
  const messageId = message.message_id;
  const msgType = message.message_type;

  log.info(
    {
      messageId,
      msgType,
      chatType: message.chat_type || '',
      chatId: message.chat_id || '',
      parentId: message.parent_id || '',
      rootId: message.root_id || '',
      senderOpenId: senderInfo?.sender_id?.open_id || 'unknown',
    },
    'incoming message received',
  );

  if (dedup.isDuplicate(messageId)) {
    log.debug({ messageId }, 'duplicate message skipped');
    return;
  }

  if (!SUPPORTED_MESSAGE_TYPES.has(msgType)) {
    log.debug({ messageId, msgType }, 'unsupported message skipped');
    return;
  }

  let text = stripMentionTokens(extractText(message.content));
  if (msgType === 'text' && !text) {
    log.debug({ messageId }, 'empty text message skipped');
    return;
  }

  const chatType = message.chat_type || '';
  const chatId = message.chat_id || '';
  const senderOpenId = senderInfo?.sender_id?.open_id || 'unknown';

  if (chatType !== 'p2p') {
    const mentioned = await shouldHandleGroupMessage(message, sender);
    if (!mentioned) {
      log.debug({ messageId }, 'group message without bot mention skipped');
      return;
    }
  }

  let sessionKey = `p2p_${senderOpenId}`;
  let replyInThread = false;
  if (chatType !== 'p2p') {
    const rootId = message.root_id || '';
    const threadId = message.thread_id || '';
    if (threadId || rootId) {
      sessionKey = `thread_${rootId}`;
    } else {
      sessionKey = `thread_${messageId}`;
      replyInThread = true;
    }
  }

  log.info(
    {
      messageId,
      sessionKey,
      replyInThread,
      textPreview: text ? summarizeText(text) : '',
    },
    'incoming message accepted',
  );

  if (msgType === 'text' && text) {
    const { handled } = await tryHandleCommand({
      text,
      messageId,
      sessionKey,
      chatId,
      sender,
      sessionManager,
    });
    if (handled) {
      return;
    }
  }

  let planMode = false;
  if (msgType === 'text' && text) {
    const match = PLAN_MODE_RE.exec(text);
    if (match) {
      planMode = true;
      text = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.trim();
    }
  }

  const saveDir =
    chatType === 'p2p'
      ? path.join(settings.uploadDir, sessionKey)
      : path.join(settings.uploadDir, sessionKey, senderOpenId);

  const parentId = message.parent_id || '';
  if (msgType === 'image' || msgType === 'file') {
    await sender.replyText(messageId, '⏳ 正在下载当前消息附件，请稍候…', replyInThread);
  } else if (parentId) {
    await sender.replyText(messageId, '⏳ 正在获取引用消息及附件，请稍候…', replyInThread);
  }

  const { attachments, tooLarge } = await extractAttachments(message, sender, saveDir);
  const parent = await extractParentAttachments(message, sender, saveDir);
  const allAttachments = attachments.concat(parent.attachments);
  const allTooLarge = tooLarge.concat(parent.meta.tooLarge);

  log.info(
    {
      messageId,
      sessionKey,
      attachments: attachments.map((item) => item.name),
      parentAttachments: parent.attachments.map((item) => item.name),
      tooLarge: allTooLarge,
      parentTypes: parent.meta.types,
      hasParentText: Boolean(parent.meta.text),
    },
    'message context prepared',
  );

  if (allTooLarge.length > 0) {
    await sender.replyText(
      messageId,
      `以下文件超过飞书下载接口限制，无法自动下载: ${allTooLarge.join(', ')}`,
      replyInThread,
    );
    if (!text && allAttachments.length === 0) {
      return;
    }
  }

  if (msgType !== 'text' && attachments.length === 0 && tooLarge.length === 0) {
    await sender.replyText(messageId, '附件下载失败，请稍后重试。', replyInThread);
    return;
  }

  if (parentId && parent.meta.hasFile && parent.attachments.length === 0 && parent.meta.tooLarge.length === 0) {
    await sender.replyText(messageId, '引用消息中的附件下载失败，将仅继续处理文本上下文。', replyInThread);
    if (!text && !parent.meta.text) {
      return;
    }
  }

  const prompt = buildPrompt({
    text,
    attachments: allAttachments,
    planMode,
    meta: {
      msgType,
      chatType,
      parentId,
      parentMsgTypes: parent.meta.types,
      parentText: parent.meta.text,
    },
  });

  if (!prompt.trim()) {
    log.info({ messageId, sessionKey }, 'empty prompt after preprocessing, message skipped');
    return;
  }

  const session = sessionManager.getOrCreateSession(sessionKey, chatId);
  // Extract correlationId from the child logger bindings for downstream propagation
  const correlationId = (log.bindings() as { correlationId?: string }).correlationId;
  log.info(
    {
      messageId,
      sessionKey,
      promptLength: prompt.length,
      promptPreview: summarizeText(prompt, 120),
      replyInThread,
    },
    'queueing message to session',
  );
  session?.sendUserMessage(prompt, messageId, replyInThread, correlationId);
}
