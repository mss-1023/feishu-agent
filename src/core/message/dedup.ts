/**
 * 消息去重 — 基于 TTL 的消息 ID 去重，防止重复处理同一条飞书消息。
 *
 * 使用双缓冲（分代）策略：维护 current 和 previous 两个 Map。
 * - isDuplicate() 先查 current，再查 previous；命中 previous 时提升到 current
 * - 每隔 ttlMs 执行一次 rotation：丢弃 previous，current 降级为 previous，创建新 current
 * - 单次 isDuplicate() 平均 O(1)，rotation 为 O(1)（仅引用交换）
 * - maxSize 约束在 current 上，超限时不再插入新条目
 */
export class TTLDedup {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private current = new Map<string, number>();
  private previous = new Map<string, number>();
  private lastRotation: number;

  constructor(ttlSeconds = 300, maxSize = 10_000) {
    this.ttlMs = ttlSeconds * 1000;
    this.maxSize = maxSize;
    this.lastRotation = Date.now();
  }

  isDuplicate(key: string): boolean {
    const now = Date.now();
    this.rotate(now);

    // Check current generation first
    if (this.current.has(key)) {
      return true;
    }

    // Check previous generation; promote to current if found
    if (this.previous.has(key)) {
      if (this.current.size < this.maxSize) {
        this.current.set(key, now);
      }
      return true;
    }

    // New key — insert into current if within maxSize
    if (this.current.size < this.maxSize) {
      this.current.set(key, now);
    }
    return false;
  }

  private rotate(now: number): void {
    const elapsed = now - this.lastRotation;
    if (elapsed < this.ttlMs) {
      return;
    }
    if (elapsed >= this.ttlMs * 2) {
      // Two or more TTL periods elapsed — both generations are stale
      this.previous = new Map<string, number>();
      this.current = new Map<string, number>();
    } else {
      // One TTL period elapsed — demote current to previous
      this.previous = this.current;
      this.current = new Map<string, number>();
    }
    this.lastRotation = now;
  }
}
