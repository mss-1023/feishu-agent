/**
 * SQLite 持久化 — 会话状态和 Skill 建议的数据库读写操作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { paths } from '../../config/config.js';
import { logger } from '../../logger.js';
import type {
  PersistedSession,
  PersistedSessionGroup,
  PersistedState,
  SkillSuggestion,
} from '../../types.js';

let database: DatabaseSync | null = null;
let migrated = false;

function openDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(paths.databaseFile), { recursive: true });
  database = new DatabaseSync(paths.databaseFile, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_groups (
      session_key TEXT PRIMARY KEY,
      reply_target TEXT NOT NULL,
      active_name TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT NOT NULL,
      name TEXT NOT NULL,
      local_session_id TEXT NOT NULL,
      claude_session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      workspace_dir TEXT NOT NULL,
      has_history INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_key, name),
      FOREIGN KEY (session_key) REFERENCES session_groups(session_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS skill_suggestions (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      skill_name TEXT NOT NULL,
      description TEXT NOT NULL,
      session_key TEXT NOT NULL,
      status TEXT NOT NULL,
      done_at INTEGER
    );
  `);

  return database;
}

function getMetadataValue(db: DatabaseSync, key: string) {
  const row = db
    .prepare('SELECT value FROM metadata WHERE key = ?')
    .get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function setMetadataValue(db: DatabaseSync, key: string, value: string) {
  db.prepare(`
    INSERT INTO metadata(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function readLegacySessionsJson() {
  if (!fs.existsSync(paths.stateFile)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(paths.stateFile, 'utf8');
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw) as PersistedState;
  } catch (error) {
    logger.error({ error, file: paths.stateFile }, 'failed to read legacy sessions json');
    return null;
  }
}

function readLegacySkillSuggestionsJson() {
  if (!fs.existsSync(paths.skillSuggestionsFile)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(paths.skillSuggestionsFile, 'utf8');
    if (!raw.trim()) {
      return [];
    }
    return JSON.parse(raw) as SkillSuggestion[];
  } catch (error) {
    logger.error(
      { error, file: paths.skillSuggestionsFile },
      'failed to read legacy skill suggestions json',
    );
    return [];
  }
}

function ensureMigration() {
  if (migrated) {
    return;
  }

  const db = openDatabase();
  const sessionGroupCount = Number(
    (db.prepare('SELECT COUNT(*) AS count FROM session_groups').get() as { count?: number }).count || 0,
  );
  const skillSuggestionCount = Number(
    (
      db.prepare('SELECT COUNT(*) AS count FROM skill_suggestions').get() as { count?: number }
    ).count || 0,
  );

  const legacyState = sessionGroupCount === 0 ? readLegacySessionsJson() : null;
  const legacySuggestions =
    skillSuggestionCount === 0 ? readLegacySkillSuggestionsJson() : [];

  if (!legacyState && legacySuggestions.length === 0) {
    migrated = true;
    return;
  }

  db.exec('BEGIN');
  try {
    if (legacyState) {
      const insertGroup = db.prepare(
        'INSERT INTO session_groups(session_key, reply_target, active_name) VALUES (?, ?, ?)',
      );
      const insertSession = db.prepare(`
        INSERT INTO sessions(
          session_key,
          name,
          local_session_id,
          claude_session_id,
          created_at,
          last_active,
          workspace_dir,
          has_history
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [sessionKey, group] of Object.entries(legacyState.sessions || {})) {
        const normalizedGroup = {
          sessionKey: (group as any).sessionKey || sessionKey,
          replyTarget: (group as any).replyTarget || (group as any).reply_target || '',
          activeName: (group as any).activeName || (group as any).active_name || null,
          sessions: (group as any).sessions || {},
        };

        insertGroup.run(
          normalizedGroup.sessionKey,
          normalizedGroup.replyTarget,
          normalizedGroup.activeName,
        );

        for (const [name, session] of Object.entries(normalizedGroup.sessions)) {
          const persisted = session as PersistedSession;
          insertSession.run(
            normalizedGroup.sessionKey,
            name,
            persisted.localSessionId,
            persisted.claudeSessionId,
            persisted.createdAt,
            persisted.lastActive,
            persisted.workspaceDir,
            persisted.hasHistory ? 1 : 0,
          );
        }
      }

      logger.info({ file: paths.stateFile }, 'migrated legacy sessions json into sqlite');
    }

    if (legacySuggestions.length > 0) {
      const insertSuggestion = db.prepare(`
        INSERT INTO skill_suggestions(
          id,
          timestamp,
          skill_name,
          description,
          session_key,
          status,
          done_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of legacySuggestions) {
        insertSuggestion.run(
          item.id || randomUUID().slice(0, 8),
          item.timestamp,
          item.skillName,
          item.description,
          item.sessionKey,
          item.status,
          item.doneAt ?? null,
        );
      }

      logger.info(
        { file: paths.skillSuggestionsFile, count: legacySuggestions.length },
        'migrated legacy skill suggestions json into sqlite',
      );
    }

    db.exec('COMMIT');
    migrated = true;
  } catch (error) {
    db.exec('ROLLBACK');
    logger.error({ error }, 'failed to migrate legacy json data into sqlite');
    throw error;
  }
}

function getDatabase() {
  const db = openDatabase();
  ensureMigration();
  return db;
}

export function loadPersistedStateFromDb(): PersistedState {
  const db = getDatabase();
  const groups = db.prepare('SELECT session_key, reply_target, active_name FROM session_groups').all() as Array<{
    session_key: string;
    reply_target: string;
    active_name: string | null;
  }>;
  const sessionRows = db.prepare(`
    SELECT
      session_key,
      name,
      local_session_id,
      claude_session_id,
      created_at,
      last_active,
      workspace_dir,
      has_history
    FROM sessions
    ORDER BY session_key, name
  `).all() as Array<{
    session_key: string;
    name: string;
    local_session_id: string;
    claude_session_id: string;
    created_at: number;
    last_active: number;
    workspace_dir: string;
    has_history: number;
  }>;

  const sessionsByGroup = new Map<string, PersistedSessionGroup['sessions']>();
  for (const row of sessionRows) {
    const existing = sessionsByGroup.get(row.session_key) || {};
    existing[row.name] = {
      localSessionId: row.local_session_id,
      claudeSessionId: row.claude_session_id,
      createdAt: row.created_at,
      lastActive: row.last_active,
      workspaceDir: row.workspace_dir,
      hasHistory: Boolean(row.has_history),
    };
    sessionsByGroup.set(row.session_key, existing);
  }

  const state: PersistedState = {
    version: Number(getMetadataValue(db, 'state_version') || 2),
    savedAt: Number(getMetadataValue(db, 'state_saved_at') || Date.now()),
    sessions: {},
  };

  for (const group of groups) {
    state.sessions[group.session_key] = {
      sessionKey: group.session_key,
      replyTarget: group.reply_target,
      activeName: group.active_name,
      sessions: sessionsByGroup.get(group.session_key) || {},
    };
  }

  return state;
}

export function savePersistedStateToDb(state: PersistedState) {
  const db = getDatabase();
  const insertGroup = db.prepare(
    'INSERT INTO session_groups(session_key, reply_target, active_name) VALUES (?, ?, ?)',
  );
  const insertSession = db.prepare(`
    INSERT INTO sessions(
      session_key,
      name,
      local_session_id,
      claude_session_id,
      created_at,
      last_active,
      workspace_dir,
      has_history
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM session_groups');

    for (const [sessionKey, group] of Object.entries(state.sessions)) {
      insertGroup.run(sessionKey, group.replyTarget, group.activeName);
      for (const [name, session] of Object.entries(group.sessions)) {
        insertSession.run(
          sessionKey,
          name,
          session.localSessionId,
          session.claudeSessionId,
          session.createdAt,
          session.lastActive,
          session.workspaceDir,
          session.hasHistory ? 1 : 0,
        );
      }
    }

    setMetadataValue(db, 'state_version', String(state.version));
    setMetadataValue(db, 'state_saved_at', String(state.savedAt));

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function addSkillSuggestionToDb(
  skillName: string,
  description: string,
  sessionKey: string,
): SkillSuggestion {
  const db = getDatabase();
  const suggestion: SkillSuggestion = {
    id: randomUUID().slice(0, 8),
    timestamp: Date.now(),
    skillName,
    description,
    sessionKey,
    status: 'pending',
  };

  db.prepare(`
    INSERT INTO skill_suggestions(
      id,
      timestamp,
      skill_name,
      description,
      session_key,
      status,
      done_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    suggestion.id,
    suggestion.timestamp,
    suggestion.skillName,
    suggestion.description,
    suggestion.sessionKey,
    suggestion.status,
    suggestion.doneAt ?? null,
  );

  return suggestion;
}

export function listSkillSuggestionsFromDb(status: 'pending' | 'done' | '' = 'pending') {
  const db = getDatabase();
  const rows = status
    ? db
        .prepare(`
          SELECT id, timestamp, skill_name, description, session_key, status, done_at
          FROM skill_suggestions
          WHERE status = ?
          ORDER BY timestamp DESC
        `)
        .all(status)
    : db
        .prepare(`
          SELECT id, timestamp, skill_name, description, session_key, status, done_at
          FROM skill_suggestions
          ORDER BY timestamp DESC
        `)
        .all();

  return rows.map((row) => {
    const item = row as {
      id: string;
      timestamp: number;
      skill_name: string;
      description: string;
      session_key: string;
      status: 'pending' | 'done';
      done_at: number | null;
    };

    return {
      id: item.id,
      timestamp: item.timestamp,
      skillName: item.skill_name,
      description: item.description,
      sessionKey: item.session_key,
      status: item.status,
      doneAt: item.done_at ?? undefined,
    } satisfies SkillSuggestion;
  });
}

export function getStorageSummary() {
  const db = getDatabase();
  const sessionGroupCount = Number(
    (db.prepare('SELECT COUNT(*) AS count FROM session_groups').get() as { count?: number }).count || 0,
  );
  const sessionCount = Number(
    (db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count?: number }).count || 0,
  );
  const skillSuggestionCount = Number(
    (
      db.prepare('SELECT COUNT(*) AS count FROM skill_suggestions').get() as { count?: number }
    ).count || 0,
  );

  return {
    databaseFile: paths.databaseFile,
    sessionGroupCount,
    sessionCount,
    skillSuggestionCount,
  };
}

export function closeStorage() {
  if (!database) {
    return;
  }
  database.close();
  database = null;
  migrated = false;
}
