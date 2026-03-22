/**
 * 应用入口 — Express 服务启动、飞书 WebSocket/Webhook 事件监听和路由注册。
 */
import express from 'express';
import * as lark from '@larksuiteoapi/node-sdk';

import { paths, settings, applyHotReload } from './config/config.js';
import { props, hasEnvLocal } from './config/config-loader.js';
import { subscribeNacosConfig } from './config/config-nacos.js';
import { logger } from './logger.js';
import { createFeishuClient, FeishuSender } from './feishu/sender.js';
import { handleIncomingMessage } from './core/message/message-handler.js';
import { SessionManager } from './core/session/session-manager.js';
import { handleCardAction } from './core/card-handler.js';
import { getRuntimeBoundaryRoots } from './core/boundary/allowlist.js';
import { closeStorage } from './core/session/storage.js';
import {
  loadProjectClaudeSettings,
  loadProjectMcpServers,
  loadProjectSystemPrompt,
  syncProjectClaudeRuntime,
} from './core/runtime/claude-runtime.js';
import { startDailyPushScheduler, executeDailyPush } from './core/daily-push.js';

const client = createFeishuClient();
const sender = new FeishuSender(client);
const sessionManager = new SessionManager(sender);
sessionManager.start();
syncProjectClaudeRuntime();

// Register Nacos config hot-reload listener
subscribeNacosConfig(props, hasEnvLocal, applyHotReload).catch((error) => {
  logger.warn({ error }, 'Failed to register Nacos config subscription');
});

let shuttingDown = false;
let stopDailyPush: (() => void) | null = null;

if (settings.pushEnabled) {
  stopDailyPush = startDailyPushScheduler(sender);
}

logger.info(
  {
    runtimeBoundaryEnabled: settings.runtimeBoundaryEnabled,
    allowlistFile: settings.hostPathAllowlistFile,
    allowlistRoots: getRuntimeBoundaryRoots(paths.workspacesDir),
  },
  'runtime boundary ready',
);

logger.info(
  {
    projectClaudeManaged: true,
    systemPromptLoaded: Boolean(loadProjectSystemPrompt()),
    mcpServers: Object.keys(loadProjectMcpServers() || {}),
    hasProjectClaudeSettings: Boolean(loadProjectClaudeSettings()),
  },
  'project claude runtime ready',
);

const eventDispatcher = new lark.EventDispatcher({
  encryptKey: settings.encryptKey || undefined,
}).register({
  'im.message.receive_v1': async (data: any) => {
    if (shuttingDown) {
      logger.warn('received message while shutting down, event ignored');
      return;
    }
    await handleIncomingMessage(data, sessionManager, sender);
  },
  'im.message.message_read_v1': async () => {},
});

const cardDispatcher = new lark.CardActionHandler(
  {
    encryptKey: settings.encryptKey || undefined,
    verificationToken: settings.verificationToken || undefined,
  },
  async (data: any) => handleCardAction(data, sessionManager),
);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.get('/health', (_req, res) => {
  res.json({
    status: shuttingDown ? 'draining' : 'ok',
    activeGroups: sessionManager.activeGroupCount(),
    websocket: settings.useWebsocket,
    shuttingDown,
  });
});
app.get('/healthz', (_req, res) => {
  res.status(shuttingDown ? 503 : 200).json({ status: shuttingDown ? 'draining' : 'ok' });
});
app.use('/event', lark.adaptExpress(eventDispatcher, { autoChallenge: true }));
app.use('/card', lark.adaptExpress(cardDispatcher));
app.post('/push/test', async (_req, res) => {
  try {
    await executeDailyPush(sender);
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: String(error) });
  }
});

const server = app.listen(settings.serverPort, () => {
  logger.info({ port: settings.serverPort }, 'TS service listening');
});

let wsClient: lark.WSClient | null = null;
if (settings.useWebsocket) {
  wsClient = new lark.WSClient({
    appId: settings.appId,
    appSecret: settings.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });
  wsClient.start({
    eventDispatcher,
  });
  logger.info('Feishu websocket client started');
}

const SHUTDOWN_TIMEOUT_MS = settings.shutdownTimeoutMs;

async function shutdown(signal: string) {
  if (shuttingDown) {
    logger.info({ signal }, 'shutdown already in progress');
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // 1. Stop accepting new messages (shuttingDown flag already set above)

  // 2. Close WebSocket client
  try {
    wsClient?.close({ force: true });
  } catch (error) {
    logger.error({ error }, 'error closing websocket client');
  }

  // 3. Stop SessionManager timers
  sessionManager.stop();

  // 3.5. Stop daily push scheduler
  stopDailyPush?.();

  // 4. Wait for all processQueue() to complete, max shutdownTimeoutMs
  const allIdle = await sessionManager.waitForIdle(SHUTDOWN_TIMEOUT_MS);
  if (!allIdle) {
    logger.warn('shutdown timeout reached, proceeding with forced shutdown');
  }

  // 5. Persist state
  try {
    sessionManager.save();
  } catch (error) {
    logger.error({ error }, 'failed to save session state during shutdown');
  }

  // 6. Close database
  try {
    closeStorage();
  } catch (error) {
    logger.error({ error }, 'failed to close storage during shutdown');
  }

  // 7. Close HTTP server with timeout for force close
  await new Promise<void>((resolve) => {
    server.close(() => {
      logger.info('http server closed');
      resolve();
    });

    setTimeout(() => {
      logger.warn('http server close timeout, forcing all connections closed');
      server.closeAllConnections();
      resolve();
    }, 5_000);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
