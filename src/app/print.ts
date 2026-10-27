import chalk from 'chalk';
import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession } from '../core/session.js';
import { PermissionController, PolicyHost } from '../core/permissions.js';
import { CostTracker, formatTokens, formatUsd } from '../core/cost.js';
import { toolHeader, toolSummary } from '../ui/tools.js';
import { renderMarkdown } from '../ui/markdown.js';
import { toolResultText } from '../core/transcript.js';

export interface PrintOptions {
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  allowTools: boolean;
  resume?: string;
  json?: boolean;
}

/**
 * Non-interactive mode (frostcode -p): one prompt, streamed to stdout, then exit.
 * Prompts that would need a human are answered by policy (--yes allows them).
 */
export async function runPrint(opts: PrintOptions): Promise<number> {
  const permissions = new PermissionController(new PolicyHost(opts.allowTools));
  const cost = new CostTracker();
  const session = new AgentSession({
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    resume: opts.resume,
    permissions,
  });
  cost.beginSession(opts.resume ?? null);
  const tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  let exitCode = 0;
  let sessionId: string | null = null;

  const done = new Promise<void>((resolve) => {
    session.subscribe((msg: SDKMessage) => {
      cost.apply(msg);
      if (opts.json) {
        process.stdout.write(JSON.stringify(msg) + '\n');
      } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        for (const block of msg.message.content as { type: string; text?: string; id?: string; name?: string; input?: unknown }[]) {
          if (block.type === 'text' && block.text?.trim()) process.stdout.write(`\n${chalk.white('●')} ${renderMarkdown(block.text)}\n`);
          if (block.type === 'tool_use' && block.id && block.name) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            tools.set(block.id, { name: block.name, input });
            const h = toolHeader(block.name, input, opts.cwd);
            process.stdout.write(`\n${chalk.gray('●')} ${chalk.bold(h.verb)}${h.arg ? `(${h.arg})` : ''}\n`);
          }
        }
      } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const t = tools.get(block.tool_use_id);
          if (!t) continue;
          const summary = toolSummary(
            {
              kind: 'tool',
              id: block.tool_use_id,
              name: t.name,
              input: t.input,
              status: block.is_error ? 'error' : 'done',
              result: toolResultText(block.content),
              detail: (msg as { tool_use_result?: unknown }).tool_use_result,
            },
            opts.cwd,
          );
          const color = block.is_error ? chalk.red : chalk.gray;
          process.stdout.write(color(`  ⎿  ${summary.split('\n').join('\n     ')}\n`));
        }
      }
      if (msg.type === 'result') {
        sessionId = msg.session_id;
        if (msg.subtype !== 'success' || msg.is_error) exitCode = 1;
        resolve();
      }
    });
    session.onExit = (err) => {
      if (err) {
        process.stderr.write(chalk.red(`\nAgent runtime error: ${err.message}\n`));
        exitCode = 1;
      }
      resolve();
    };
  });

  session.send(opts.prompt);
  await done;
  await session.close();
  if (!opts.json) {
    const c = cost.snapshot();
    process.stderr.write(
      chalk.dim(
        `\n${formatUsd(c.sessionUsd)} · ${formatTokens(c.tokens.input + c.tokens.cacheRead + c.tokens.cacheWrite)} in · ${formatTokens(c.tokens.output)} out` +
          (sessionId ? ` · session ${sessionId} (resume with: frostcode --resume ${sessionId})` : '') +
          '\n',
      ),
    );
  }
  return exitCode;
}
