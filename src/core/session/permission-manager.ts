/**
 * PermissionManager — 权限审批管理，支持超时自动 deny 和批量清理。
 * 从 ClaudeSession 拆分出的独立模块，可独立实例化和单元测试。
 */
import type { PendingPermissionRecord } from '../../types.js';

/**
 * 内部存储结构：每个未决权限请求的完整上下文。
 * 使用显式 `timerId` 存储避免竞态条件。
 */
interface PendingPermissionEntry {
  record: PendingPermissionRecord;
  resolve: (decision: 'allow' | 'deny') => void;
  timerId: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

export class PermissionManager {
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingPermissionEntry>();

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * 注册一个权限请求，返回 Promise 等待用户决策或超时自动 deny。
   * 内部创建 `setTimeout` 用于超时自动 deny，超时回调检查 Map 中是否仍存在该条目以避免竞态。
   */
  register(requestId: string, record: PendingPermissionRecord): Promise<'allow' | 'deny'> {
    return new Promise<'allow' | 'deny'>((resolve) => {
      const timerId = setTimeout(() => {
        // 超时回调：仅当条目仍存在时才执行清理（避免与 resolve() 竞态）
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          resolve('deny');
        }
      }, this.timeoutMs);

      this.pending.set(requestId, {
        record,
        resolve,
        timerId,
        expiresAt: Date.now() + this.timeoutMs,
      });
    });
  }

  /**
   * 提前解析权限请求，取消超时定时器。
   * @returns 对应的 PendingPermissionRecord，若请求不存在则返回 null
   */
  resolve(requestId: string, decision: 'allow' | 'deny'): PendingPermissionRecord | null {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return null;
    }
    clearTimeout(entry.timerId);
    this.pending.delete(requestId);
    entry.resolve(decision);
    return entry.record;
  }

  /**
   * 批量清理所有未决权限请求：逐一 deny 并清除定时器。
   * 用于会话销毁时防止内存泄漏。
   */
  clearAllPending(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timerId);
      entry.resolve('deny');
    }
    this.pending.clear();
  }

  /** 当前未决权限请求数量 */
  get pendingCount(): number {
    return this.pending.size;
  }
}
