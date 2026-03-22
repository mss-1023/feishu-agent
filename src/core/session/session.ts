/**
 * Claude 会话核心 — 协调者模式，将消息队列、权限管理和流式输出委托给独立模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  query,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import { settings, CONSTANTS } from '../../config/config.js';
import { logger } from '../../logger.js';
import { createWindowsClaudeSpawner } from './claude-spawner.js';
import type { PersistedSession } from '../../types.js';
import {
  buildStreamingCard,
} from '../../feishu/cards.js';
import type { FeishuSender } from '../../feishu/sender.js';
import { StreamParser } from '../runtime/stream-parser.js';
import {
  evaluatePermission,
  AUTO_ALLOW_TOOLS,
  type PermissionContext,
  type PermissionCallbacks,
} from './permission-handler.js';
import {
  buildProjectClaudeEnv,
  loadProjectClaudeSettings,
  loadProjectMcpServers,
  loadProjectSystemPrompt,
} from '../runtime/claude-runtime.js';
import { QueueManager, type QueuedMessage } from './queue-manager.js';
import { PermissionManager } from './permission-manager.js';
import { StreamHandler } from './stream-handler.js';

function summarizeLogText(text: string, maxLength: number = CONSTANTS.LOG_SUMMARY_MAX_LENGTH) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

export class ClaudeSession {
  readonly sessionKey: string;
  readonly localSessionId: string;
  readonly claudeSessionId: string;
  readonly workspaceDir: string;

  private readonly sender: FeishuSender;
  private readonly replyTarget: () => string;
  private readonly queueManager: QueueManager;
  private readonly permissionManager: PermissionManager;
  private readonly streamHandler: StreamHandler;
  private processing = false;

  /** Whether this session is currently processing its queue */
  get isProcessing(): boolean {
    return this.processing;
  }
  private currentRootMessageId: string | null = null;
  private currentCardMessageId: string | null = null;

  createdAt: number;
  lastActive: number;
  private hasHistory: boolean;
  private bypassMode = false;
  private bypassUntil = 0;
  private smartBypassMode = false;
  private smartBypassUntil = 0;

  constructor(input: {
    sessionKey: string;
    sender: FeishuSender;
    replyTarget: () => string;
    persisted?: PersistedSession;
    workspaceDir?: string;
    persistState?: () => void;
  }) {
    this.sessionKey = input.sessionKey;
    this.sender = input.sender;
    this.replyTarget = input.replyTarget;
    this.localSessionId = input.persisted?.localSessionId || randomUUID();
    this.claudeSessionId = input.persisted?.claudeSessionId || randomUUID();
    this.workspaceDir =
      input.persisted?.workspaceDir ||
      input.workspaceDir ||
      path.join(settings.sessionBaseDir, 'workspaces', this.sessionKey, this.localSessionId);
    this.createdAt = input.persisted?.createdAt || Date.now();
    this.lastActive = input.persisted?.lastActive || Date.now();
    this.hasHistory = input.persisted?.hasHistory || false;

    this.queueManager = new QueueManager(settings.maxSessionQueueSize);
    this.permissionManager = new PermissionManager(settings.permissionTimeoutSeconds * 1000);
    this.streamHandler = new StreamHandler({
      bufferMaxChars: settings.streamBufferMaxChars,
    });

    fs.mkdirSync(this.workspaceDir, { recursive: true });
  }

  toJSON(): PersistedSession {
    return {
      localSessionId: this.localSessionId,
      claudeSessionId: this.claudeSessionId,
      createdAt: this.createdAt,
      lastActive: this.lastActive,
      workspaceDir: this.workspaceDir,
      hasHistory: this.hasHistory,
    };
  }

  setBypassMode(enabled: boolean, durationSeconds = settings.bypassTimeoutSeconds) {
    this.bypassMode = enabled;
    this.bypassUntil = enabled ? Date.now() + durationSeconds * 1000 : 0;
  }

  setSmartBypass(durationSeconds = settings.smartBypassTimeoutSeconds) {
    this.smartBypassMode = true;
    this.smartBypassUntil = Date.now() + durationSeconds * 1000;
  }

  isBypassActive() {
    if (!this.bypassMode) {
      return false;
    }
    if (Date.now() > this.bypassUntil) {
      this.bypassMode = false;
      this.bypassUntil = 0;
      return false;
    }
    return true;
  }

  private isSmartBypassActive() {
    if (!this.smartBypassMode) {
      return false;
    }
    if (Date.now() > this.smartBypassUntil) {
      this.smartBypassMode = false;
      this.smartBypassUntil = 0;
      return false;
    }
    return true;
  }

  sendUserMessage(prompt: string, rootMessageId?: string, replyInThread = false, correlationId?: string) {
    this.lastActive = Date.now();

    const enqueued = this.queueManager.enqueue({
      prompt,
      rootMessageId,
      replyInThread,
      enqueuedAt: Date.now(),
      correlationId,
    });

    if (!enqueued) {
      logger.warn(
        {
          sessionKey: this.sessionKey,
          localSessionId: this.localSessionId,
          queueLength: this.queueManager.length,
          promptLength: prompt.length,
        },
        'session message rejected: queue full (backpressure)',
      );
      void this.sender.sendText(
        this.replyTarget(),
        '⚠️ 消息队列已满，请稍后再试。当前有太多待处理消息。',
      );
      return;
    }

    logger.info(
      {
        sessionKey: this.sessionKey,
        localSessionId: this.localSessionId,
        queueLength: this.queueManager.length,
        rootMessageId: rootMessageId || null,
        replyInThread,
        promptLength: prompt.length,
        promptPreview: summarizeLogText(prompt),
      },
      'session message queued',
    );
    void this.processQueue();
  }

  resolvePermission(requestId: string, decision: 'allow' | 'deny') {
    return this.permissionManager.resolve(requestId, decision);
  }

  private async processQueue() {
    if (this.processing) {
      logger.debug({ sessionKey: this.sessionKey, queueLength: this.queueManager.length }, 'session queue already processing');
      return;
    }
    this.processing = true;
    logger.info({ sessionKey: this.sessionKey, queueLength: this.queueManager.length }, 'session queue processing started');
    try {
      let item: QueuedMessage | undefined;
      while ((item = this.queueManager.dequeue()) !== undefined) {
        await this.processMessage(item);
      }
    } finally {
      this.processing = false;
      logger.info({ sessionKey: this.sessionKey, queueLength: this.queueManager.length }, 'session queue processing finished');
    }
  }

  private async processMessage(item: QueuedMessage) {
    logger.info(
      {
        sessionKey: this.sessionKey,
        localSessionId: this.localSessionId,
        claudeSessionId: this.claudeSessionId,
        rootMessageId: item.rootMessageId || null,
        replyInThread: item.replyInThread,
        workspaceDir: this.workspaceDir,
        hasHistory: this.hasHistory,
      },
      'session message processing started',
    );
    this.currentRootMessageId = item.rootMessageId || null;
    this.currentCardMessageId = null;

    // Reset stream handler for this message
    this.streamHandler.reset();

    // Add a "Typing" emoji reaction to indicate thinking (like Claude's typing indicator)
    let typingReactionId: string | null = null;
    if (item.rootMessageId) {
      typingReactionId = await this.sender.addReaction(item.rootMessageId, 'Typing');
    }

    logger.info(
      {
        sessionKey: this.sessionKey,
        rootMessageId: item.rootMessageId || null,
        typingReactionId,
      },
      'typing reaction added',
    );

    let errorMessage = '';
    let stderrBuffer = '';
    let sawTextDelta = false;
    const parser = new StreamParser({
      onTextDelta: (text) => {
        sawTextDelta = true;
        this.streamHandler.appendText(text);
      },
      onToolUse: (name, input) => {
        logger.info(
          {
            sessionKey: this.sessionKey,
            toolName: name,
            toolInputPreview: summarizeLogText(JSON.stringify(input || {}), 200),
          },
          'agent tool used',
        );
      },
    });

    const runAgentQuery = async (resumeMode: boolean) => {
      const options = {
        cwd: this.workspaceDir,
        includePartialMessages: true,
        model: settings.claudeModel,
        systemPrompt: loadProjectSystemPrompt(),
        settings: loadProjectClaudeSettings(),
        mcpServers: loadProjectMcpServers(),
        pathToClaudeCodeExecutable: settings.claudeExecutable,
        spawnClaudeCodeProcess: createWindowsClaudeSpawner(settings.claudeExecutable, (chunk) => {
          stderrBuffer = `${stderrBuffer}${chunk}`.slice(-CONSTANTS.STDERR_BUFFER_MAX_CHARS);
        }),
        tools: { type: 'preset' as const, preset: 'claude_code' as const },
        allowedTools: Array.from(AUTO_ALLOW_TOOLS),
        permissionMode: 'default' as const,
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          options: { title?: string; description?: string; toolUseID: string },
        ) => this.handlePermission(toolName, input, options),
        env: {
          ...buildProjectClaudeEnv(process.env),
          CLAUDE_AGENT_SDK_CLIENT_APP: 'ai-container-ts/0.1.0',
        },
        ...(resumeMode
          ? { resume: this.claudeSessionId }
          : { sessionId: this.claudeSessionId }),
      };

      logger.info(
        {
          sessionKey: this.sessionKey,
          model: settings.claudeModel,
          resumeMode: resumeMode ? 'resume' : 'new',
          mcpServers: Object.keys(loadProjectMcpServers() || {}),
          workspaceDir: this.workspaceDir,
        },
        'starting agent query',
      );

      const stream = query({
        prompt: item.prompt,
        options,
      });

      for await (const message of stream) {
        if (message.type === 'stream_event') {
          parser.feed(message.event);
          continue;
        }

        if (message.type === 'assistant') {
          if (!sawTextDelta && !this.streamHandler.getBuffer()) {
            const content = (message.message.content || []) as unknown as Array<Record<string, unknown>>;
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                this.streamHandler.appendText(block.text);
              }
            }
          }
          continue;
        }

        if (message.type === 'result') {
          logger.info(
            {
              sessionKey: this.sessionKey,
              subtype: message.subtype,
              isError: message.is_error,
            },
            'agent result received',
          );
          if (message.subtype === 'success' && !this.streamHandler.getBuffer() && typeof message.result === 'string') {
            this.streamHandler.appendText(message.result);
          }
          if (message.subtype !== 'success') {
            errorMessage = message.errors.join('\n') || 'Claude execution failed.';
          } else {
            this.hasHistory = true;
          }
        }
      }
    };

    try {
      const queryStart = Date.now();
      await runAgentQuery(this.hasHistory);
      logger.info(
        { sessionKey: this.sessionKey, claudeQueryLatencyMs: Date.now() - queryStart },
        'claude query completed',
      );
    } catch (error) {
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      const trimmedStderr = stderrBuffer.trim();
      const sessionInUse =
        !this.hasHistory &&
        rawErrorMessage.includes('Claude Code process exited with code 1') &&
        trimmedStderr.includes('is already in use');

      if (sessionInUse) {
        logger.warn(
          {
            sessionKey: this.sessionKey,
            claudeSessionId: this.claudeSessionId,
            stderr: summarizeLogText(trimmedStderr, 300),
          },
          'session id already exists, retrying agent query with resume',
        );
        this.hasHistory = true;
        stderrBuffer = '';
        errorMessage = '';
        sawTextDelta = false;
        this.streamHandler.reset();
        try {
          const retryQueryStart = Date.now();
          await runAgentQuery(true);
          logger.info(
            { sessionKey: this.sessionKey, claudeQueryLatencyMs: Date.now() - retryQueryStart },
            'claude query retry completed',
          );
        } catch (retryError) {
          errorMessage = retryError instanceof Error ? retryError.message : String(retryError);
          if (stderrBuffer.trim()) {
            logger.error(
              {
                sessionKey: this.sessionKey,
                stderr: summarizeLogText(stderrBuffer.trim(), 300),
              },
              'agent query stderr',
            );
          }
          logger.error({ error: retryError, sessionKey: this.sessionKey }, 'agent query retry failed');
        }
      } else {
        errorMessage = rawErrorMessage;
        if (trimmedStderr) {
          logger.error(
            {
              sessionKey: this.sessionKey,
              stderr: summarizeLogText(trimmedStderr, 300),
            },
            'agent query stderr',
          );
        }
        logger.error({ error, sessionKey: this.sessionKey }, 'agent query failed');
      }
    }

    const messageLatencyMs = Date.now() - item.enqueuedAt;

    // Remove the typing reaction
    if (typingReactionId && item.rootMessageId) {
      await this.sender.deleteReaction(item.rootMessageId, typingReactionId);
    }

    if (errorMessage) {
      // Send error as a card reply
      const errorCard = buildStreamingCard(errorMessage, 'error');
      if (item.rootMessageId) {
        await this.sender.replyCard(item.rootMessageId, errorCard, item.replyInThread);
      } else {
        await this.sender.sendCard(this.replyTarget(), errorCard);
      }
      logger.error(
        {
          sessionKey: this.sessionKey,
          rootMessageId: item.rootMessageId || null,
          errorMessage,
          messageLatencyMs,
        },
        'session message processing failed',
      );
    } else {
      const buffer = this.streamHandler.getBuffer();
      // Send completed result as a card reply
      const completeCard = buildStreamingCard(buffer, 'complete');
      if (item.rootMessageId) {
        await this.sender.replyCard(item.rootMessageId, completeCard, item.replyInThread);
      } else {
        await this.sender.sendCard(this.replyTarget(), completeCard);
      }
      logger.info(
        {
          sessionKey: this.sessionKey,
          rootMessageId: item.rootMessageId || null,
          responseLength: buffer.length,
          responsePreview: summarizeLogText(buffer),
          messageLatencyMs,
        },
        'session message processing completed',
      );
    }
  }

  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      title?: string;
      description?: string;
      toolUseID: string;
    },
  ): Promise<PermissionResult> {
    const context: PermissionContext = {
      sessionKey: this.sessionKey,
      workspaceDir: this.workspaceDir,
      isBypassActive: () => this.isBypassActive(),
      isSmartBypassActive: () => this.isSmartBypassActive(),
      currentCardMessageId: this.currentCardMessageId,
      currentRootMessageId: this.currentRootMessageId,
      sender: this.sender,
    };

    const callbacks: PermissionCallbacks = {
      registerPending: (requestId, record, resolve) => {
        // Bridge: PermissionManager owns the timeout and state; when it resolves
        // (either via explicit resolve() or timeout), forward the decision to the
        // permission-handler's Promise resolve callback.
        this.permissionManager.register(requestId, record).then(resolve);
      },
    };

    return evaluatePermission(toolName, input, options, context, callbacks);
  }
}
