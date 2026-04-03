/**
 * 每日 AI 知识推送 — 定时调用 Claude 生成学习内容，通过飞书推送到指定用户和群聊。
 */
import Anthropic from '@anthropic-ai/sdk';

import { settings } from '../config/config.js';
import { logger } from '../logger.js';
import type { FeishuSender } from '../feishu/sender.js';
import { buildDailyPushCard } from '../feishu/cards.js';

const TOPICS = [
  // === AI/ML 基础 ===
  'AI 与机器学习基础：监督学习、无监督学习、强化学习的区别',
  '神经网络基础：反向传播、激活函数与梯度下降',
  'Embedding（向量嵌入）：语义表示与相似度计算原理',
  '注意力机制（Attention）：从 Seq2Seq 到 Self-Attention',
  'Transformer 架构的核心原理：编码器、解码器与位置编码',
  // === 大语言模型核心 ===
  '大语言模型（LLM）是怎么训练出来的：预训练与指令微调',
  'Tokenization 原理：BPE、WordPiece 与 Token 的本质',
  'RLHF（人类反馈强化学习）：如何让 AI 对齐人类价值观',
  'Constitutional AI：Anthropic 的 AI 安全对齐方法',
  'AI 幻觉问题：成因分析与 5 种减少幻觉的实用方法',
  // === Prompt 工程 ===
  'Prompt Engineering 核心技巧：零样本、少样本与思维链',
  'System Prompt 设计：如何定义 AI 的身份与行为边界',
  '结构化输出：让 AI 稳定输出 JSON、Markdown 的技巧',
  'Prompt 安全：提示注入攻击与防御方法',
  // === RAG 与向量数据库 ===
  '向量数据库原理：Chroma、Milvus、Pinecone 的使用场景',
  'RAG（检索增强生成）完整工作流：从文档到回答',
  'RAG 优化技巧：Chunking 策略、重排序与混合检索',
  // === Agent 系统 ===
  'Function Calling 与 Tool Use：让 AI 调用外部工具',
  'Agent 系统架构：ReAct、规划器与记忆模块',
  'MCP（Model Context Protocol）：AI 工具标准化协议',
  '多 Agent 协作：如何设计 AI 团队完成复杂任务',
  // === 模型微调与部署 ===
  '大模型微调方法：LoRA、QLoRA 与 PEFT 的区别',
  '本地部署大模型：Ollama 使用与模型量化原理',
  'MoE（混合专家模型）架构：GPT-4 和 Mixtral 背后的技术',
  '多模态模型：视觉语言模型（VLM）的工作原理',
  // === AI 工程实践 ===
  'LangChain 核心概念：Chain、Memory 与 Retriever',
  'AI 应用评估：如何衡量 RAG 和 Agent 系统的质量',
  '大模型 API 成本优化：Token 计算与缓存策略',
  'AI 全栈开发路线：从 API 调用到生产级 AI 应用',
  'Claude Code 与 Agent SDK：构建自主编程 Agent 的实践',
];

/** 按年中第几天轮换主题 */
function getTodayTopic(): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  return TOPICS[dayOfYear % TOPICS.length];
}

/** 调用 Claude API 生成学习内容 */
async function generateContent(topic: string): Promise<string> {
  const baseURL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;

  if (!apiKey) {
    throw new Error('ANTHROPIC_AUTH_TOKEN not configured');
  }

  const model = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5-20251001';

  const response = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `请用通俗易懂的方式讲解：${topic}\n\n要求：\n1. 先用1句话说清楚是什么\n2. 用3-5个要点解释核心原理\n3. 举一个实际应用例子\n4. 最后给一个进一步学习的建议\n\n控制在 400 字以内，适合每日学习。用中文回答。`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const textBlock = data.content?.find((b: any) => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

/** 格式化日期 YYYY-MM-DD */
function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 执行一次每日推送 */
export async function executeDailyPush(sender: FeishuSender): Promise<void> {
  const topic = getTodayTopic();
  const date = formatDate();

  logger.info({ topic, date }, 'daily push started');

  let content: string;
  try {
    content = await generateContent(topic);
  } catch (error) {
    logger.error({ error, topic }, 'failed to generate daily push content');
    return;
  }

  if (!content) {
    logger.warn({ topic }, 'daily push content is empty, skipping');
    return;
  }

  const card = buildDailyPushCard(date, topic, content);
  const targets = [
    ...settings.pushTargetUsers.map((id) => ({ id, type: 'user' as const })),
    ...settings.pushTargetGroups.map((id) => ({ id, type: 'group' as const })),
  ];

  if (targets.length === 0) {
    logger.info('no push targets configured, skipping daily push');
    return;
  }

  for (const target of targets) {
    try {
      const idType = target.type === 'user' ? 'open_id' : 'chat_id';
      await sender.sendCard(target.id, card, idType);
      logger.info({ targetId: target.id, targetType: target.type }, 'daily push sent');
    } catch (error) {
      logger.error({ error, targetId: target.id }, 'failed to send daily push');
    }
  }

  logger.info({ topic, date, targetCount: targets.length }, 'daily push completed');
}

/** 启动每日推送定时器，返回清理函数 */
export function startDailyPushScheduler(sender: FeishuSender): () => void {
  const pushHour = settings.pushHour;
  const pushMinute = settings.pushMinute;

  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(pushHour, pushMinute, 0, 0);

    // 如果今天的推送时间已过，设为明天
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    const delay = next.getTime() - now.getTime();
    logger.info(
      { nextPush: next.toISOString(), delayMs: delay },
      'daily push scheduled',
    );

    return setTimeout(async () => {
      try {
        await executeDailyPush(sender);
      } catch (error) {
        logger.error({ error }, 'daily push execution failed');
      }
      // 推送完成后调度下一次
      timerId = scheduleNext();
    }, delay);
  }

  let timerId = scheduleNext();

  return () => {
    clearTimeout(timerId);
    logger.info('daily push scheduler stopped');
  };
}
