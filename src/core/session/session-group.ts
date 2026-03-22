/**
 * 会话分组 — 同一聊天上下文下的多会话管理，支持创建、切换、重命名和删除。
 */
import { ClaudeSession } from './session.js';
import type { PersistedSessionGroup } from '../../types.js';
import type { FeishuSender } from '../../feishu/sender.js';

export class SessionGroup {
  readonly sessionKey: string;
  private activeName: string | null;
  private sessions = new Map<string, ClaudeSession>();
  private replyTarget: string;
  private readonly sender: FeishuSender;
  private readonly persistState?: () => void;

  constructor(input: {
    sessionKey: string;
    replyTarget: string;
    sender: FeishuSender;
    persisted?: PersistedSessionGroup;
    persistState?: () => void;
  }) {
    this.sessionKey = input.sessionKey;
    this.replyTarget = input.replyTarget;
    this.sender = input.sender;
    this.persistState = input.persistState;
    this.activeName = input.persisted?.activeName || null;
    if (input.persisted) {
      for (const [name, session] of Object.entries(input.persisted.sessions)) {
        this.sessions.set(
          name,
          new ClaudeSession({
            sessionKey: input.sessionKey,
            sender: this.sender,
            replyTarget: () => this.replyTarget,
            persisted: session,
            persistState: this.persistState,
          }),
        );
      }
    }
  }

  setReplyTarget(replyTarget: string) {
    this.replyTarget = replyTarget;
  }

  ensureDefault() {
    if (this.sessions.size === 0) {
      this.createSession('default', true);
    }
    return this.getActiveSession();
  }

  createSession(name = `session-${this.sessions.size + 1}`, switchToNew = true) {
    if (this.sessions.has(name)) {
      return null;
    }
    const session = new ClaudeSession({
      sessionKey: this.sessionKey,
      sender: this.sender,
      replyTarget: () => this.replyTarget,
      persistState: this.persistState,
    });
    this.sessions.set(name, session);
    if (switchToNew || !this.activeName) {
      this.activeName = name;
    }
    return { name, session };
  }

  getActiveSession() {
    return this.activeName ? this.sessions.get(this.activeName) || null : null;
  }

  switchSession(name: string) {
    if (!this.sessions.has(name)) {
      return null;
    }
    this.activeName = name;
    const session = this.sessions.get(name)!;
    session.lastActive = Date.now();
    return session;
  }

  deleteSession(name: string) {
    if (!this.sessions.has(name)) {
      return { ok: false, reason: 'Session does not exist.' };
    }
    if (name === this.activeName) {
      return { ok: false, reason: 'Cannot delete the active session.' };
    }
    this.sessions.delete(name);
    return { ok: true };
  }

  renameActiveSession(newName: string) {
    if (!this.activeName) {
      return { ok: false, reason: 'No active session.' };
    }
    if (this.sessions.has(newName)) {
      return { ok: false, reason: 'Session name already exists.' };
    }
    const active = this.sessions.get(this.activeName)!;
    const oldName = this.activeName;
    this.sessions.delete(oldName);
    this.sessions.set(newName, active);
    this.activeName = newName;
    return { ok: true, oldName };
  }

  resetActiveSession() {
    if (!this.activeName) {
      return false;
    }
    this.sessions.delete(this.activeName);
    this.activeName = null;
    this.ensureDefault();
    return true;
  }

  listSessions() {
    return [...this.sessions.entries()]
      .map(([name, session]) => ({
        name,
        isActive: name === this.activeName,
        createdAt: session.createdAt,
        lastActive: session.lastActive,
      }))
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.lastActive - a.lastActive);
  }

  toJSON(): PersistedSessionGroup {
    const sessions: PersistedSessionGroup['sessions'] = {};
    for (const [name, session] of this.sessions.entries()) {
      sessions[name] = session.toJSON();
    }
    return {
      sessionKey: this.sessionKey,
      replyTarget: this.replyTarget,
      activeName: this.activeName,
      sessions,
    };
  }

  /** 获取该分组下所有会话中最近一次活跃时间 */
  getLastActive(): number {
    let latest = 0;
    for (const session of this.sessions.values()) {
      if (session.lastActive > latest) {
        latest = session.lastActive;
      }
    }
    return latest;
  }

  /** 获取该分组下所有会话实例 */
  getAllSessions(): ClaudeSession[] {
    return [...this.sessions.values()];
  }
}
