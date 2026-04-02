/**
 * 日志监控系统 — 收集错误日志并通过飞书推送
 */
import { readFileSync } from 'fs';
import { logger } from '../logger.js';
import type { FeishuSender } from '../feishu/sender.js';

interface ErrorLog {
  time: string;
  level: number;
  message: string;
  error?: string;
}

/** 解析日志文件，提取错误日志 */
function parseErrorLogs(logPath: string, since: Date): ErrorLog[] {
  try {
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const errors: ErrorLog[] = [];

    for (const line of lines) {
      try {
        const log = JSON.parse(line);
        if (log.level >= 50 && log.time >= since.getTime()) {
          errors.push({
            time: new Date(log.time).toISOString(),
            level: log.level,
            message: log.msg || '',
            error: log.error ? JSON.stringify(log.error) : undefined,
          });
        }
      } catch {
        // 跳过无法解析的行
      }
    }

    return errors;
  } catch (error) {
    logger.error({ error, logPath }, 'failed to parse error logs');
    return [];
  }
}

/** 构建错误日志卡片 */
function buildErrorLogCard(date: string, errors: ErrorLog[]): any {
  const elements: any[] = [];

  if (errors.length === 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: '✅ 今日无错误日志',
      },
    });
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: `⚠️ 今日共 ${errors.length} 条错误`,
      },
    });

    elements.push({ tag: 'hr' });

    for (const err of errors.slice(0, 10)) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**时间**: ${err.time}\n**消息**: ${err.message}`,
        },
      });
    }

    if (errors.length > 10) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: `... 还有 ${errors.length - 10} 条错误`,
        },
      });
    }
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `📊 错误日志报告 - ${date}`,
      },
      template: errors.length > 0 ? 'red' : 'green',
    },
    elements,
  };
}

/** 执行每日错误日志推送 */
export async function executeDailyErrorReport(
  sender: FeishuSender,
  logPath: string,
  targetChatId: string,
): Promise<void> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const date = yesterday.toISOString().split('T')[0];

  logger.info({ date }, 'daily error report started');

  const errors = parseErrorLogs(logPath, yesterday);
  const card = buildErrorLogCard(date, errors);

  try {
    await sender.sendCard(targetChatId, card, 'chat_id');
    logger.info({ date, errorCount: errors.length }, 'daily error report sent');
  } catch (error) {
    logger.error({ error, date }, 'failed to send daily error report');
  }
}

/** 启动每日错误报告定时器 */
export function startErrorReportScheduler(
  sender: FeishuSender,
  logPath: string,
  targetChatId: string,
  hour: number,
  minute: number,
): () => void {
  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);

    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    const delay = next.getTime() - now.getTime();
    logger.info({ nextReport: next.toISOString(), delayMs: delay }, 'error report scheduled');

    return setTimeout(async () => {
      try {
        await executeDailyErrorReport(sender, logPath, targetChatId);
      } catch (error) {
        logger.error({ error }, 'error report execution failed');
      }
      timerId = scheduleNext();
    }, delay);
  }

  let timerId = scheduleNext();

  return () => {
    clearTimeout(timerId);
    logger.info('error report scheduler stopped');
  };
}
