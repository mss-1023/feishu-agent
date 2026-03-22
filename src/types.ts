/**
 * 共享类型定义 — 会话持久化、权限记录、Skill 建议等跨模块接口。
 */
export type SessionKey = string;

export interface PendingPermissionRecord {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  description?: string;
}

export interface SkillSuggestion {
  id: string;
  timestamp: number;
  skillName: string;
  description: string;
  sessionKey: string;
  status: 'pending' | 'done';
  doneAt?: number;
}

export interface PersistedSession {
  localSessionId: string;
  claudeSessionId: string;
  createdAt: number;
  lastActive: number;
  workspaceDir: string;
  hasHistory?: boolean;
}

export interface PersistedSessionGroup {
  sessionKey: string;
  replyTarget: string;
  activeName: string | null;
  sessions: Record<string, PersistedSession>;
}

export interface PersistedState {
  version: number;
  savedAt: number;
  sessions: Record<string, PersistedSessionGroup>;
}
