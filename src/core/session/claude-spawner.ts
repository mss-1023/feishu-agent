/**
 * Windows Claude CLI 进程创建 — 处理 Windows 平台下 .cmd/.bat/.ps1 包装脚本的进程启动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import type {
  SpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';

function quoteCmdPath(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteCmdArg(value: string) {
  return `"${value.replace(/([()%!^"`<>&|])/g, '^$1')}"`;
}

function resolveWindowsClaudeWrapperTarget(claudeExecutable: string) {
  if (process.platform !== 'win32') {
    return null;
  }

  const lower = claudeExecutable.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat') && !lower.endsWith('.ps1')) {
    return null;
  }

  const installDir = path.dirname(claudeExecutable);
  const cliEntry = path.join(installDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (!fs.existsSync(cliEntry)) {
    return null;
  }

  const bundledNode = path.join(installDir, 'node.exe');
  return {
    command: fs.existsSync(bundledNode) ? bundledNode : 'node',
    argsPrefix: [cliEntry],
  };
}

function toSpawnedProcess(child: ChildProcess): SpawnedProcess {
  if (!child.stdin || !child.stdout) {
    throw new Error('Claude process did not expose stdin/stdout pipes.');
  }

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill: child.kill.bind(child),
    on: child.on.bind(child) as SpawnedProcess['on'],
    once: child.once.bind(child) as SpawnedProcess['once'],
    off: child.off.bind(child) as SpawnedProcess['off'],
  };
}


export function createWindowsClaudeSpawner(
  claudeExecutable: string,
  onStderr?: (chunk: string) => void,
) {
  if (process.platform !== 'win32') {
    return undefined;
  }

  const wrapperTarget = resolveWindowsClaudeWrapperTarget(claudeExecutable);
  if (wrapperTarget) {
    return (input: SpawnOptions): SpawnedProcess => {
      const child = spawn(wrapperTarget.command, [...wrapperTarget.argsPrefix, ...input.args], {
        cwd: input.cwd,
        env: input.env,
        signal: input.signal,
        stdio: 'pipe',
        windowsHide: true,
      });
      child.stderr?.on('data', (chunk) => onStderr?.(chunk.toString()));
      return toSpawnedProcess(child);
    };
  }

  const lower = claudeExecutable.toLowerCase();

  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return (input: SpawnOptions): SpawnedProcess => {
      const commandLine = `${quoteCmdPath(input.command)} ${input.args
        .map((arg) => quoteCmdArg(arg))
        .join(' ')}`;
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
          cwd: input.cwd,
          env: input.env,
          signal: input.signal,
          windowsVerbatimArguments: true,
          stdio: 'pipe',
        });
      child.stderr?.on('data', (chunk) => onStderr?.(chunk.toString()));
      return toSpawnedProcess(child);
    };
  }

  if (lower.endsWith('.ps1')) {
    return (input: SpawnOptions): SpawnedProcess => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', input.command, ...input.args],
        {
          cwd: input.cwd,
          env: input.env,
          signal: input.signal,
          stdio: 'pipe',
        },
      );
      child.stderr?.on('data', (chunk) => onStderr?.(chunk.toString()));
      return toSpawnedProcess(child);
    };
  }

  return undefined;
}
