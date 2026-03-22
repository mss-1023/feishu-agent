/**
 * 会话管理器 — 管理所有会话分组的生命周期，负责持久化加载和保存。
 */
import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../../logger.js';
import { settings } from '../../config/config.js';
import type { PersistedState } from '../../types.js';
import type { FeishuSender } from '../../feishu/sender.js';
import { SessionGroup } from './session-group.js';
import { getStorageSummary, loadPersistedStateFromDb, savePersistedStateToDb } from './storage.js';

export class SessionManager {
  private readonly sender: FeishuSender;
  private groups = new Map<string, SessionGroup>();
  private saveTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;
  private uploadCleanupTimer?: NodeJS.Timeout;
  private readonly persistState: () => void;

  constructor(sender: FeishuSender) {
    this.sender = sender;
    this.persistState = () => this.save();
  }

  start() {
    this.load();
    this.saveTimer = setInterval(() => {
      try {
        this.save();
      } catch (error) {
        logger.error({ error }, 'failed to save session state');
      }
    }, settings.saveIntervalMs);

    // 每 cleanupIntervalMs 检查一次不活跃会话
    this.cleanupTimer = setInterval(() => {
      try {
        this.cleanupInactive();
      } catch (error) {
        logger.error({ error }, 'failed to cleanup inactive sessions');
      }
    }, settings.cleanupIntervalMs);

    // 每 metricsIntervalMs 记录活跃会话指标
    this.metricsTimer = setInterval(() => {
      try {
        this.logSessionMetrics();
      } catch (error) {
        logger.error({ error }, 'failed to log session metrics');
      }
    }, settings.metricsIntervalMs);

    // 每 cleanupIntervalMs 清理过期上传文件
    this.uploadCleanupTimer = setInterval(() => {
      this.cleanupUploads().catch((error) => {
        logger.error({ error }, 'failed to cleanup upload files');
      });
    }, settings.cleanupIntervalMs);
  }

  stop() {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }
    if (this.uploadCleanupTimer) {
      clearInterval(this.uploadCleanupTimer);
      this.uploadCleanupTimer = undefined;
    }
    try {
      this.save();
    } catch (error) {
      logger.error({ error }, 'failed to save session state on shutdown');
    }
  }

  getOrCreateGroup(sessionKey: string, replyTarget: string) {
    const existing = this.groups.get(sessionKey);
    if (existing) {
      existing.setReplyTarget(replyTarget);
      return existing;
    }
    const group = new SessionGroup({
      sessionKey,
      replyTarget,
      sender: this.sender,
      persistState: this.persistState,
    });
    this.groups.set(sessionKey, group);
    return group;
  }

  getGroup(sessionKey: string) {
    return this.groups.get(sessionKey) || null;
  }

  getOrCreateSession(sessionKey: string, replyTarget: string) {
    return this.getOrCreateGroup(sessionKey, replyTarget).ensureDefault();
  }

  getSession(sessionKey: string) {
    return this.groups.get(sessionKey)?.getActiveSession() || null;
  }

  resetSession(sessionKey: string) {
    const group = this.groups.get(sessionKey);
    if (!group) {
      return false;
    }
    return group.resetActiveSession();
  }

  activeGroupCount() {
    return this.groups.size;
  }

  /** 定期记录活跃会话分组数量和总会话数量（空闲时不打印） */
  private logSessionMetrics() {
    if (this.groups.size === 0) return;
    let totalSessions = 0;
    for (const group of this.groups.values()) {
      totalSessions += group.getAllSessions().length;
    }
    logger.info(
      { activeGroups: this.groups.size, totalSessions },
      'session metrics',
    );
  }

  /** 扫描 uploadDir 下所有文件，删除超过 uploadRetentionMs 的过期文件 */
  private async cleanupUploads(): Promise<void> {
    const uploadDir = settings.uploadDir;
    const retentionMs = settings.uploadRetentionMs;
    const now = Date.now();
    let deletedCount = 0;
    let freedBytes = 0;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(uploadDir, { withFileTypes: true });
    } catch (error) {
      // uploadDir may not exist yet — nothing to clean
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger.error({ error, uploadDir }, 'failed to read upload directory');
      return;
    }

    // Collect files recursively
    const filePaths: string[] = [];
    const collectFiles = (dir: string, dirents: fs.Dirent[]) => {
      for (const dirent of dirents) {
        const fullPath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          try {
            const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
            collectFiles(fullPath, subEntries);
          } catch (error) {
            logger.error({ error, path: fullPath }, 'failed to read upload subdirectory');
          }
        } else if (dirent.isFile()) {
          filePaths.push(fullPath);
        }
      }
    };
    collectFiles(uploadDir, entries);

    for (const filePath of filePaths) {
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > retentionMs) {
          fs.unlinkSync(filePath);
          deletedCount++;
          freedBytes += stat.size;
        }
      } catch (error) {
        logger.error({ error, path: filePath }, 'failed to delete expired upload file');
      }
    }

    if (deletedCount > 0) {
      logger.info(
        { deletedCount, freedBytes, freedMB: (freedBytes / (1024 * 1024)).toFixed(2) },
        'cleaned up expired upload files',
      );
    }
  }

  /** 清理超过 sessionInactiveTimeoutMs 未活跃的会话分组 */
  private cleanupInactive() {
    const now = Date.now();
    const timeout = settings.sessionInactiveTimeoutMs;
    const toRemove: string[] = [];

    for (const [sessionKey, group] of this.groups.entries()) {
      const lastActive = group.getLastActive();
      if (lastActive > 0 && now - lastActive > timeout) {
        toRemove.push(sessionKey);
      }
    }

    if (toRemove.length > 0) {
      for (const key of toRemove) {
        this.groups.delete(key);
      }
      logger.info(
        { removed: toRemove.length, remaining: this.groups.size, sessionIds: toRemove },
        'cleaned up inactive session groups',
      );
      this.save();
    }
  }

  save() {
    const state: PersistedState = {
      version: 2,
      savedAt: Date.now(),
      sessions: {},
    };
    for (const [sessionKey, group] of this.groups.entries()) {
      state.sessions[sessionKey] = group.toJSON();
    }
    savePersistedStateToDb(state);
    const summary = getStorageSummary();
    logger.info(summary, 'session state saved');
  }

  /**
   * 等待所有会话的 processQueue() 完成。
   * @param timeoutMs 最长等待时间（毫秒），超时后返回
   * @returns true 表示所有会话已空闲，false 表示超时
   */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 200;

    while (Date.now() < deadline) {
      let anyProcessing = false;
      for (const group of this.groups.values()) {
        for (const session of group.getAllSessions()) {
          if (session.isProcessing) {
            anyProcessing = true;
            break;
          }
        }
        if (anyProcessing) break;
      }

      if (!anyProcessing) {
        logger.info('all sessions idle, waitForIdle resolved');
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    logger.warn({ timeoutMs }, 'waitForIdle timed out, some sessions still processing');
    return false;
  }

  private load() {
    try {
      const parsed = loadPersistedStateFromDb();
      for (const [sessionKey, group] of Object.entries(parsed.sessions || {})) {
        if (!group || typeof group !== 'object') {
          continue;
        }
        if (!('sessions' in group)) {
          continue;
        }
        const normalizedGroup = {
          sessionKey: (group as any).sessionKey || sessionKey,
          replyTarget: (group as any).replyTarget || (group as any).reply_target || '',
          activeName: (group as any).activeName || (group as any).active_name || null,
          sessions: (group as any).sessions || {},
        };
        this.groups.set(
          normalizedGroup.sessionKey,
          new SessionGroup({
            sessionKey: normalizedGroup.sessionKey,
            replyTarget: normalizedGroup.replyTarget,
            sender: this.sender,
            persisted: normalizedGroup,
            persistState: this.persistState,
          }),
        );
      }
      logger.info({ groups: this.groups.size }, 'restored session state');
      logger.info(getStorageSummary(), 'sqlite session storage ready');
    } catch (error) {
      logger.error({ error }, 'failed to load session state');
    }
  }
}
