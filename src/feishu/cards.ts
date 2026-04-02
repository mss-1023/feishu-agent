/**
 * 飞书卡片构建 — 生成各类飞书交互卡片 JSON（权限审批、帮助、会话列表、流式输出等）。
 */
import type { InteractiveCard } from '@larksuiteoapi/node-sdk';
import { CONSTANTS } from '../config/config.js';

function truncateContent(content: string, maxLength = 8000): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `... (content truncated) ...\n${content.slice(-maxLength)}`;
}

function header(
  title: string,
  template: NonNullable<InteractiveCard['header']>['template'] = 'blue',
) {
  return {
    title: {
      tag: 'plain_text' as const,
      content: title,
    },
    template,
  };
}

function markdown(content: string) {
  return {
    tag: 'markdown' as const,
    content,
  };
}

export function buildThinkingCard(): InteractiveCard {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: header('🤔 思考中...', 'blue'),
    elements: [
      markdown('正在分析你的问题...'),
    ],
  };
}

export function buildStreamingCard(
  content: string,
  status: 'complete' | 'error',
): InteractiveCard {
  const normalized = truncateContent(content, CONSTANTS.STREAM_CARD_TRUNCATE_LENGTH);
  const headerByStatus = {
    complete: header('🤖 Agent', 'green'),
    error: header('❌ 错误', 'red'),
  };

  return {
    config: {
      wide_screen_mode: true,
    },
    header: headerByStatus[status],
    elements: [
      markdown(
        normalized || (status === 'error' ? '请求处理失败。' : '无内容。'),
      ),
    ],
  };
}

export function buildToolUseCard(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
}): InteractiveCard {
  const body = truncateContent(JSON.stringify(input.toolInput, null, 2), 2000);
  return {
    config: {
      wide_screen_mode: true,
    },
    header: header(`🛠️ 工具调用: ${input.toolName}`, 'orange'),
    elements: [markdown(`\`\`\`json\n${body}\n\`\`\``)],
  };
}

export function buildPermissionCard(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionKey: string;
  requestId: string;
  title?: string;
  description?: string;
}): InteractiveCard {
  const toolBody = truncateContent(JSON.stringify(input.toolInput, null, 2), 2000);
  return {
    config: {
      wide_screen_mode: true,
    },
    header: header(`⚠️ 权限请求: ${input.toolName}`, 'red'),
    elements: [
      markdown(
        [
          input.title || 'Claude 请求使用工具。',
          input.description || '',
          '```json',
          toolBody,
          '```',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '✅ 批准' },
            value: {
              action_type: 'permission_approve',
              session_key: input.sessionKey,
              request_id: input.requestId,
            },
          },
          {
            tag: 'button',
            type: 'danger',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            value: {
              action_type: 'permission_deny',
              session_key: input.sessionKey,
              request_id: input.requestId,
            },
          },
          {
            tag: 'button',
            type: 'default',
            text: { tag: 'plain_text', content: '🔓 安全操作自动放行 10 分钟' },
            value: {
              action_type: 'permission_skip_10min',
              session_key: input.sessionKey,
              request_id: input.requestId,
            },
          },
        ],
      },
    ],
  };
}

export function buildPermissionResolvedCard(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  decision: 'allow' | 'deny';
  operatorOpenId?: string;
}): InteractiveCard {
  const actor = input.operatorOpenId ? `<at id=${input.operatorOpenId}></at>` : 'User';
  const body = truncateContent(JSON.stringify(input.toolInput, null, 2), 2000);
  const approved = input.decision === 'allow';

  return {
    config: {
      wide_screen_mode: true,
    },
    header: header(
      `${approved ? '✅ 已批准' : '🚫 已拒绝'}: ${input.toolName}`,
      approved ? 'green' : 'grey',
    ),
    elements: [
      markdown(
        `${actor} ${approved ? '批准' : '拒绝'}了此操作。\n\`\`\`json\n${body}\n\`\`\``,
      ),
    ],
  };
}

export function buildSessionListCard(
  sessionKey: string,
  sessions: Array<{
    name: string;
    isActive: boolean;
    createdAt: number;
    lastActive: number;
  }>,
): InteractiveCard {
  const elements: InteractiveCard['elements'] = [];
  for (const session of sessions) {
    const title = session.isActive ? `**${session.name}** (active)` : `**${session.name}**`;
    elements.push(
      markdown(
        `${title}\nCreated: ${new Date(session.createdAt).toLocaleString()}\nLast active: ${new Date(session.lastActive).toLocaleString()}`,
      ),
    );
    if (!session.isActive) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: 'Switch' },
            value: {
              action_type: 'session_switch',
              session_key: sessionKey,
              session_name: session.name,
            },
          },
          {
            tag: 'button',
            type: 'danger',
            text: { tag: 'plain_text', content: 'Delete' },
            value: {
              action_type: 'session_delete',
              session_key: sessionKey,
              session_name: session.name,
            },
          },
        ],
      });
    }
    elements.push({ tag: 'hr' });
  }

  if (elements.length > 0 && elements[elements.length - 1]?.tag === 'hr') {
    elements.pop();
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: header(`Sessions (${sessions.length})`, 'blue'),
    elements: elements.length > 0 ? elements : [markdown('No sessions')],
  };
}

export function buildHelpCard(): InteractiveCard {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: header('Help', 'blue'),
    elements: [
      markdown(
        [
          '**Commands**',
          '- `/new [name]` create and switch to a new session',
          '- `/switch <name>` switch session',
          '- `/list` list sessions',
          '- `/rename <new-name>` rename current session',
          '- `/delete <name>` delete a non-active session',
          '- `/reset` reset the active session',
          '- `/restart` save state and restart service',
          '- `/help` show this card',
          '- `/skill优化 [skill] description` record a skill improvement suggestion',
          '- `/skill优化列表` list pending skill suggestions',
          '',
          '**Bypass**',
          '- `我要开启bypass模式` allow all tool calls for 5 minutes',
          '- `退出bypass模式` disable bypass mode',
        ].join('\n'),
      ),
    ],
  };
}

export function buildSkillSuggestionRecordedCard(input: {
  id: string;
  skillName: string;
  description: string;
  timestamp: number;
  pendingCount: number;
}): InteractiveCard {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: header('Skill suggestion recorded', 'green'),
    elements: [
      markdown(
        [
          `**Skill:** ${input.skillName || '(unspecified)'}`,
          `**Description:** ${input.description}`,
          '',
          `Recorded at: ${new Date(input.timestamp).toLocaleString()}`,
          `Suggestion id: \`${input.id}\``,
          `Pending suggestions: **${input.pendingCount}**`,
        ].join('\n'),
      ),
    ],
  };
}

export function buildSkillSuggestionsListCard(
  suggestions: Array<{
    id: string;
    skillName: string;
    description: string;
    timestamp: number;
  }>,
): InteractiveCard {
  const elements: InteractiveCard['elements'] = [];
  if (suggestions.length === 0) {
    elements.push(markdown('No pending skill suggestions.'));
  } else {
    for (const item of suggestions) {
      elements.push(
        markdown(
          [
            `**[${item.id}]** \`${item.skillName || '(unspecified)'}\``,
            item.description,
            `_${new Date(item.timestamp).toLocaleString()}_`,
          ].join('\n'),
        ),
      );
      elements.push({ tag: 'hr' });
    }
    if (elements[elements.length - 1]?.tag === 'hr') {
      elements.pop();
    }
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: header(`Pending skill suggestions (${suggestions.length})`, 'blue'),
    elements,
  };
}


export function buildDailyPushCard(
  date: string,
  topic: string,
  content: string,
): InteractiveCard {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: header(`📚 每日 AI 知识 [${date}]`, 'purple'),
    elements: [
      markdown(`**🎯 主题：${topic}**`),
      { tag: 'hr' },
      markdown(truncateContent(content, 4000)),
    ],
  };
}
