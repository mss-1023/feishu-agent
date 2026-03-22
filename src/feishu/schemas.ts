/**
 * 飞书事件与卡片动作的 Zod Schema 定义 — 提供运行时校验和 TypeScript 类型推断。
 */
import { z } from 'zod';

/**
 * 飞书消息事件 schema（im.message.receive_v1 回调）。
 *
 * 注意：飞书 SDK 的 EventDispatcher.register 回调传入的 data 已经是
 * 解包后的事件体（即 { message, sender }），不包含外层 { event: ... } 包装。
 *
 * 必需字段：message.message_id, message.message_type
 * 可选字段：content, chat_type, chat_id, parent_id, root_id, thread_id, mentions, sender
 */
export const feishuMessageEventSchema = z.object({
  message: z.object({
    message_id: z.string(),
    message_type: z.string(),
    content: z.string().optional(),
    chat_type: z.string().optional(),
    chat_id: z.string().optional(),
    parent_id: z.string().optional(),
    root_id: z.string().optional(),
    thread_id: z.string().optional(),
    mentions: z
      .array(
        z.object({
          id: z.object({ open_id: z.string().optional() }).optional(),
        }),
      )
      .optional(),
  }),
  sender: z
    .object({
      sender_id: z.object({ open_id: z.string().optional() }).optional(),
    })
    .optional(),
});

/**
 * 飞书卡片动作 schema（交互卡片回调）。
 *
 * action.value 可以是 JSON 字符串或对象。
 * operator 为可选，包含操作者的 open_id。
 */
export const feishuCardActionSchema = z.object({
  action: z.object({
    value: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
  operator: z
    .object({
      open_id: z.string().optional(),
    })
    .optional(),
});

export type FeishuMessageEvent = z.infer<typeof feishuMessageEventSchema>;
export type FeishuCardAction = z.infer<typeof feishuCardActionSchema>;
