/**
 * QueueManager — 消息队列管理，支持背压检查。
 * 从 ClaudeSession 拆分出的独立模块，可独立实例化和单元测试。
 */
import { logger } from '../../logger.js';

export interface QueuedMessage {
  prompt: string;
  rootMessageId?: string;
  replyInThread: boolean;
  enqueuedAt: number;       // 入队时间戳，用于性能指标
  correlationId?: string;   // 关联 ID，用于请求追踪
}

export class QueueManager {
  private readonly maxSize: number;
  private readonly queue: QueuedMessage[] = [];

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /**
   * 入队消息。检查与入队为同步操作，保证原子性（Node.js 单线程）。
   * @returns `true` 入队成功，`false` 队列已满（背压拒绝）
   */
  enqueue(message: QueuedMessage): boolean {
    if (this.queue.length >= this.maxSize) {
      return false;
    }
    this.queue.push(message);
    logger.info({ queueDepth: this.queue.length }, 'queue enqueue');
    return true;
  }

  /**
   * 出队消息（FIFO）。
   * @returns 队首消息，队列为空时返回 `undefined`
   */
  dequeue(): QueuedMessage | undefined {
    const message = this.queue.shift();
    if (message) {
      logger.info({ queueDepth: this.queue.length }, 'queue dequeue');
    }
    return message;
  }

  /** 当前队列长度 */
  get length(): number {
    return this.queue.length;
  }

  /** 队列是否已满 */
  get isFull(): boolean {
    return this.queue.length >= this.maxSize;
  }

  /** 清空队列 */
  clear(): void {
    this.queue.length = 0;
  }
}
