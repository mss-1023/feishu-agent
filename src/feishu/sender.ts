/**
 * 飞书 API 封装 — 消息发送、卡片更新、资源下载，内置速率限制。
 */
import fs from 'node:fs';
import path from 'node:path';

import * as lark from '@larksuiteoapi/node-sdk';
import type { InteractiveCard } from '@larksuiteoapi/node-sdk';

import { settings } from '../config/config.js';
import { logger } from '../logger.js';

function summarizeContent(content: string, maxLength = 120) {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FeishuSender {
  private client: lark.Client;
  private tokens: number;
  private lastRefill: number;
  private botOpenId?: string | null;

  constructor(client: lark.Client) {
    this.client = client;
    this.tokens = settings.feishuMaxRps;
    this.lastRefill = Date.now();
  }

  private async rateLimit() {
    while (true) {
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      const refill = (elapsed / 1000) * settings.feishuMaxRps;
      this.tokens = Math.min(settings.feishuMaxRps, this.tokens + refill);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(1000 / settings.feishuMaxRps);
    }
  }

  private async sendMessage(payload: {
    receiveId?: string;
    messageId?: string;
    replyInThread?: boolean;
    msgType: 'text' | 'interactive';
    content: string;
    receiveIdType?: 'chat_id' | 'open_id';
  }): Promise<string | null> {
    await this.rateLimit();
    logger.info(
      {
        action: payload.messageId ? 'reply' : 'create',
        msgType: payload.msgType,
        receiveId: payload.receiveId,
        messageId: payload.messageId,
        replyInThread: payload.replyInThread || false,
        contentPreview: summarizeContent(payload.content),
      },
      'sending feishu message',
    );
    try {
      if (payload.messageId) {
        const response = await this.client.im.v1.message.reply({
          path: {
            message_id: payload.messageId,
          },
          data: {
            msg_type: payload.msgType,
            content: payload.content,
            reply_in_thread: payload.replyInThread,
          },
        });
        if (response.code === 0) {
          logger.info(
            {
              action: 'reply',
              msgType: payload.msgType,
              messageId: payload.messageId,
              replyMessageId: response.data?.message_id || null,
            },
            'feishu reply sent',
          );
          return response.data?.message_id || null;
        }
        logger.error({ response }, 'reply message failed');
        return null;
      }

      const response = await this.client.im.v1.message.create({
        params: {
          receive_id_type: payload.receiveIdType || 'chat_id',
        },
        data: {
          receive_id: payload.receiveId || '',
          msg_type: payload.msgType,
          content: payload.content,
        },
      });
      if (response.code === 0) {
        logger.info(
          {
            action: 'create',
            msgType: payload.msgType,
            receiveId: payload.receiveId,
            createdMessageId: response.data?.message_id || null,
          },
          'feishu message sent',
        );
        return response.data?.message_id || null;
      }
      logger.error({ response }, 'create message failed');
      return null;
    } catch (error) {
      logger.error({ error }, 'send message failed');
      return null;
    }
  }

  async sendText(receiveId: string, text: string) {
    return this.sendMessage({
      receiveId,
      msgType: 'text',
      content: JSON.stringify({ text }),
    });
  }

  async replyText(messageId: string, text: string, replyInThread = false) {
    return this.sendMessage({
      messageId,
      replyInThread,
      msgType: 'text',
      content: JSON.stringify({ text }),
    });
  }

  async sendCard(receiveId: string, card: InteractiveCard, receiveIdType?: 'chat_id' | 'open_id') {
    return this.sendMessage({
      receiveId,
      msgType: 'interactive',
      content: JSON.stringify(card),
      receiveIdType: receiveIdType || 'chat_id',
    });
  }

  async replyCard(messageId: string, card: InteractiveCard, replyInThread = false) {
    return this.sendMessage({
      messageId,
      replyInThread,
      msgType: 'interactive',
      content: JSON.stringify(card),
    });
  }

  async updateCard(messageId: string, card: InteractiveCard) {
    await this.rateLimit();
    try {
      const response = await this.client.im.v1.message.patch({
        path: {
          message_id: messageId,
        },
        data: {
          content: JSON.stringify(card),
        },
      });
      if (response.code !== 0) {
        logger.error({ response }, 'update card failed');
      } else {
        logger.debug({ messageId }, 'feishu card updated');
      }
    } catch (error) {
      logger.error({ error }, 'update card exception');
    }
  }

  async getMessage(messageId: string) {
    await this.rateLimit();
    try {
      const response = await this.client.im.v1.message.get({
        path: {
          message_id: messageId,
        },
      });
      logger.info(
        {
          messageId,
          itemCount: Array.isArray((response.data as any)?.items) ? (response.data as any).items.length : 0,
        },
        'feishu message fetched',
      );
      return response.data || null;
    } catch (error) {
      logger.error({ error, messageId }, 'get message failed');
      return null;
    }
  }

  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    resourceType: 'file' | 'image',
    savePath: string,
  ): Promise<true | 'TOO_LARGE' | false> {
    await this.rateLimit();
    try {
      const response: any = await this.client.im.v1.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType,
        },
      });
      if (response?.code === 234037) {
        logger.info({ messageId, fileKey, resourceType }, 'message resource too large');
        return 'TOO_LARGE';
      }
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      await response.writeFile(savePath);
      logger.info({ messageId, fileKey, resourceType, savePath }, 'message resource downloaded');
      return true;
    } catch (error: any) {
      if (error?.code === 234037) {
        logger.info({ messageId, fileKey, resourceType }, 'message resource too large');
        return 'TOO_LARGE';
      }
      logger.error({ error, messageId, fileKey }, 'download resource failed');
      return false;
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    await this.rateLimit();
    try {
      const response: any = await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      if (response.code === 0) {
        logger.debug({ messageId, emojiType, reactionId: response.data?.reaction_id }, 'reaction added');
        return response.data?.reaction_id || null;
      }
      logger.error({ response, messageId, emojiType }, 'add reaction failed');
      return null;
    } catch (error) {
      logger.error({ error, messageId, emojiType }, 'add reaction exception');
      return null;
    }
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    await this.rateLimit();
    try {
      const response: any = await this.client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      if (response.code !== 0) {
        logger.error({ response, messageId, reactionId }, 'delete reaction failed');
      } else {
        logger.debug({ messageId, reactionId }, 'reaction deleted');
      }
    } catch (error) {
      logger.error({ error, messageId, reactionId }, 'delete reaction exception');
    }
  }

  async getBotOpenId() {
    if (this.botOpenId !== undefined) {
      return this.botOpenId;
    }
    await this.rateLimit();
    try {
      const response: any = await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      // 飞书 SDK client.request() 返回结构可能是 { bot: { open_id } } 或 { data: { bot: { open_id } } }
      this.botOpenId = response?.bot?.open_id || response?.data?.bot?.open_id || null;
      logger.info({ botOpenId: this.botOpenId }, 'resolved bot open id');
      return this.botOpenId;
    } catch (error) {
      logger.error({ error }, 'failed to fetch bot open id');
      this.botOpenId = null;
      return this.botOpenId;
    }
  }
}

export function createFeishuClient() {
  return new lark.Client({
    appId: settings.appId,
    appSecret: settings.appSecret,
    domain: lark.Domain.Feishu,
    appType: lark.AppType.SelfBuild,
  });
}
