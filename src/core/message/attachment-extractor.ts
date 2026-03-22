/**
 * 附件提取 — 从飞书消息和引用消息中下载图片、文件附件。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { FeishuSender } from '../../feishu/sender.js';
import type { Attachment } from './prompt.js';

export function parseMessageJson(content: string | undefined): Record<string, unknown> {
  if (!content) {
    return {};
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function extractAttachments(
  message: any,
  sender: FeishuSender,
  saveDir: string,
): Promise<{ attachments: Attachment[]; tooLarge: string[] }> {
  const attachments: Attachment[] = [];
  const tooLarge: string[] = [];
  fs.mkdirSync(saveDir, { recursive: true });

  const content = parseMessageJson(message.content);
  if (message.message_type === 'image' && typeof content.image_key === 'string') {
    const filename = `${content.image_key}.png`;
    const savePath = path.join(saveDir, filename);
    const result = await sender.downloadMessageResource(
      message.message_id,
      content.image_key,
      'image',
      savePath,
    );
    if (result === true) {
      attachments.push({ type: 'image', path: savePath, name: filename });
    } else if (result === 'TOO_LARGE') {
      tooLarge.push(filename);
    }
  }

  if (message.message_type === 'file' && typeof content.file_key === 'string') {
    const filename =
      typeof content.file_name === 'string' ? content.file_name : 'uploaded-file';
    const savePath = path.join(saveDir, filename);
    const result = await sender.downloadMessageResource(
      message.message_id,
      content.file_key,
      'file',
      savePath,
    );
    if (result === true) {
      attachments.push({ type: 'file', path: savePath, name: filename });
    } else if (result === 'TOO_LARGE') {
      tooLarge.push(filename);
    }
  }

  return { attachments, tooLarge };
}

export async function extractParentAttachments(
  message: any,
  sender: FeishuSender,
  saveDir: string,
): Promise<{
  attachments: Attachment[];
  meta: {
    types: string[];
    text: string;
    hasFile: boolean;
    tooLarge: string[];
  };
}> {
  const parentId = message.parent_id || '';
  const empty = {
    attachments: [] as Attachment[],
    meta: {
      types: [] as string[],
      text: '',
      hasFile: false,
      tooLarge: [] as string[],
    },
  };

  if (!parentId) {
    return empty;
  }

  const parentData: any = await sender.getMessage(parentId);
  const items = Array.isArray(parentData?.items) ? parentData.items : [];
  if (items.length === 0) {
    return empty;
  }

  const attachments: Attachment[] = [];
  const tooLarge: string[] = [];
  const types: string[] = [];
  let text = '';

  fs.mkdirSync(saveDir, { recursive: true });

  for (const item of items) {
    const itemType =
      (typeof item.msg_type === 'string' && item.msg_type) ||
      (typeof item.message_type === 'string' && item.message_type) ||
      '';
    types.push(itemType);
    const content = parseMessageJson(item.body?.content || item.content);

    if (itemType === 'text') {
      if (typeof content.text === 'string') {
        text = content.text;
      }
      continue;
    }

    if (itemType === 'image' && typeof content.image_key === 'string') {
      const filename = `${content.image_key}.png`;
      const savePath = path.join(saveDir, filename);
      const result = await sender.downloadMessageResource(
        parentId,
        content.image_key,
        'image',
        savePath,
      );
      if (result === true) {
        attachments.push({ type: 'image', path: savePath, name: filename });
      } else if (result === 'TOO_LARGE') {
        tooLarge.push(filename);
      }
      continue;
    }

    if (itemType === 'file' && typeof content.file_key === 'string') {
      const filename =
        typeof content.file_name === 'string' ? content.file_name : 'parent-file';
      const savePath = path.join(saveDir, filename);
      const result = await sender.downloadMessageResource(
        parentId,
        content.file_key,
        'file',
        savePath,
      );
      if (result === true) {
        attachments.push({ type: 'file', path: savePath, name: filename });
      } else if (result === 'TOO_LARGE') {
        tooLarge.push(filename);
      }
    }
  }

  return {
    attachments,
    meta: {
      types,
      text,
      hasFile: types.some((type) => type === 'image' || type === 'file'),
      tooLarge,
    },
  };
}
