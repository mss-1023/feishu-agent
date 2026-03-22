/**
 * Prompt 构建 — 将用户文本、附件和上下文元数据组装为发送给 Claude 的 prompt。
 */
export interface PromptMeta {
  msgType?: string;
  chatType?: string;
  parentId?: string;
  parentMsgTypes?: string[];
  parentText?: string;
}

export interface Attachment {
  type: 'file' | 'image';
  path: string;
  name: string;
}

const SYSTEM_CONTEXT = [
  '[System Context]',
  'You are running as a Feishu bot assistant.',
  'The current working directory is a per-session workspace, not automatically the user project.',
  'Do not browse or edit unrelated service files unless the user explicitly asks.',
  'If the user asks a general programming question, prefer answering directly instead of creating files.',
].join('\n');

export function buildPrompt(input: {
  text: string;
  attachments: Attachment[];
  planMode: boolean;
  meta: PromptMeta;
}): string {
  const parts: string[] = [SYSTEM_CONTEXT];

  if (input.planMode) {
    parts.push(
      'Enter planning mode first. Analyze and propose a plan before making code changes.',
    );
  }

  const metaLines: string[] = [];
  if (input.meta.msgType) metaLines.push(`- Message type: ${input.meta.msgType}`);
  if (input.meta.chatType) metaLines.push(`- Chat type: ${input.meta.chatType}`);
  if (input.meta.parentId) metaLines.push(`- Parent message id: ${input.meta.parentId}`);
  if (input.meta.parentMsgTypes?.length) {
    metaLines.push(`- Parent message types: ${input.meta.parentMsgTypes.join(', ')}`);
  }
  if (input.meta.parentText) {
    metaLines.push(`- Parent message text: ${input.meta.parentText.slice(0, 200)}`);
  }
  if (metaLines.length > 0) {
    parts.push('[Feishu Message Metadata]');
    parts.push(metaLines.join('\n'));
  }

  if (input.attachments.length > 0) {
    parts.push('The user uploaded these files. Use the local paths directly.');
    for (const attachment of input.attachments) {
      parts.push(`- ${attachment.path} (${attachment.type})`);
    }
  }

  if (input.text) {
    parts.push(`User message: ${input.text}`);
  }

  return parts.join('\n\n');
}
