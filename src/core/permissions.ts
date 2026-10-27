import type { CanUseTool, PermissionMode, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

export type PromptRequest =
  | {
      kind: 'tool';
      id: string;
      toolName: string;
      toolUseId: string;
      input: Record<string, unknown>;
      title?: string;
      description?: string;
      reason?: string;
      /** False when the runtime says an "always allow" rule would grant too much. */
      allowAlways: boolean;
      /** The prompt opens on "No" and has no one-key approve. */
      defaultToNo: boolean;
      /** Rule an "always allow" answer would add for this session, e.g. Bash(npm test:*). */
      ruleLabel: string;
      /** A sensitive MCP call: approval is for this call only. */
      sensitive?: boolean;
    }
  | { kind: 'plan'; id: string; toolUseId: string; plan: string }
  | { kind: 'question'; id: string; toolUseId: string; questions: QuestionSpec[] };

export interface QuestionSpec {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

export type PromptAnswer =
  | { kind: 'allow'; always?: boolean }
  | { kind: 'deny'; feedback?: string }
  | { kind: 'plan-approve'; mode: Extract<PermissionMode, 'default' | 'acceptEdits'> }
  | { kind: 'plan-reject'; feedback?: string }
  | { kind: 'answers'; answers: Record<string, string> }
  | { kind: 'cancel' };

/** Whatever shows prompts to the user: the Ink UI, or a fixed policy in print mode. */
export interface PromptHost {
  ask(req: PromptRequest, signal: AbortSignal): Promise<PromptAnswer>;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Tools that run a command line: Bash everywhere, PowerShell on Windows. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

/** The session rule an "always allow" answer adds. Shell rules are scoped to the command's first word. */
export function ruleFor(toolName: string, input: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(toolName) && typeof input.command === 'string') {
    const first = input.command.trim().split(/\s+/)[0] ?? '';
    return first ? `${toolName}(${first}:*)` : toolName;
  }
  if (EDIT_TOOLS.has(toolName)) return 'Edit';
  return toolName;
}

export function ruleMatches(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const m = /^([^()]+)\((.*)\)$/.exec(rule);
  if (!m) return rule === toolName || (rule === 'Edit' && EDIT_TOOLS.has(toolName));
  const [, tool, spec] = m;
  if (tool !== toolName) return false;
  if (SHELL_TOOLS.has(toolName) && typeof input.command === 'string') {
    const cmd = input.command.trim();
    if (spec.endsWith(':*')) {
      const prefix = spec.slice(0, -2);
      // Never let a prefix rule approve a compound command that chains something else
      // (a newline separates commands in both shells; PowerShell's escape is the backtick).
      if (/[;&|`$<>\r\n]/.test(cmd)) return false;
      return cmd === prefix || cmd.startsWith(prefix + ' ');
    }
    return cmd === spec;
  }
  return false;
}

let reqCounter = 0;

/**
 * FrostCode's canUseTool: session allow rules first, then the prompt host.
 * Also answers the two interactive tools, ExitPlanMode and AskUserQuestion.
 */
export class PermissionController {
  readonly sessionRules = new Set<string>();
  /** tool_use ids the user denied (lets the transcript render them as denials). */
  onDenied: (toolUseId: string) => void = () => {};
  onModeChange: (mode: PermissionMode) => void = () => {};

  constructor(private host: PromptHost) {}

  setHost(host: PromptHost): void {
    this.host = host;
  }

  readonly canUseTool: CanUseTool = async (toolName, input, opts) => {
    const id = `req-${++reqCounter}`;
    if (toolName === 'ExitPlanMode') return this.handlePlan(id, input, opts.toolUseID, opts.signal);
    if (toolName === 'AskUserQuestion') return this.handleQuestion(id, input, opts.toolUseID, opts.signal);

    for (const rule of this.sessionRules) {
      if (ruleMatches(rule, toolName, input)) return { behavior: 'allow', updatedInput: input };
    }

    const ruleLabel = ruleFor(toolName, input);
    const answer = await this.host.ask(
      {
        kind: 'tool',
        id,
        toolName,
        toolUseId: opts.toolUseID,
        input,
        title: opts.title,
        description: opts.description,
        reason: opts.decisionReason,
        allowAlways: !opts.suppressAlwaysAllowRule,
        defaultToNo: !!opts.defaultToNo,
        ruleLabel,
      },
      opts.signal,
    );

    if (answer.kind === 'allow') {
      const result: PermissionResult = { behavior: 'allow', updatedInput: input };
      if (answer.always && !opts.suppressAlwaysAllowRule) {
        this.sessionRules.add(ruleLabel);
        if (opts.suggestions?.length) result.updatedPermissions = sessionScoped(opts.suggestions);
      }
      return result;
    }
    this.onDenied(opts.toolUseID);
    const feedback = answer.kind === 'deny' && answer.feedback ? answer.feedback.trim() : '';
    return {
      behavior: 'deny',
      message: feedback
        ? `The user declined this tool use and said: ${feedback}`
        : 'The user declined this tool use. Stop and wait for the user to tell you how to proceed.',
      interrupt: !feedback,
    };
  };

  /**
   * One-off approval for a sensitive call (an MCP tool that is not read-only). Session allow
   * rules do not apply and there is no "don't ask again": every call is put to the user.
   */
  async askExplicit(req: { toolName: string; input: Record<string, unknown>; toolUseId: string; reason: string }, signal: AbortSignal): Promise<boolean> {
    const answer = await this.host.ask(
      {
        kind: 'tool',
        id: `req-${++reqCounter}`,
        toolName: req.toolName,
        toolUseId: req.toolUseId,
        input: req.input,
        reason: req.reason,
        allowAlways: false,
        defaultToNo: true,
        ruleLabel: req.toolName,
        sensitive: true,
      },
      signal,
    );
    if (answer.kind === 'allow') return true;
    this.onDenied(req.toolUseId);
    return false;
  }

  private async handlePlan(
    id: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const plan = typeof input.plan === 'string' ? input.plan : '';
    const answer = await this.host.ask({ kind: 'plan', id, toolUseId, plan }, signal);
    if (answer.kind === 'plan-approve') {
      this.onModeChange(answer.mode);
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode: answer.mode, destination: 'session' }],
      };
    }
    const feedback = answer.kind === 'plan-reject' ? answer.feedback?.trim() : '';
    return {
      behavior: 'deny',
      message: feedback
        ? `The user wants to keep planning. Their feedback: ${feedback}`
        : 'The user rejected the plan and wants to keep planning. Ask what they would like changed.',
    };
  }

  private async handleQuestion(
    id: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const questions = (Array.isArray(input.questions) ? input.questions : []) as QuestionSpec[];
    const answer = await this.host.ask({ kind: 'question', id, toolUseId, questions }, signal);
    if (answer.kind === 'answers') {
      return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers } };
    }
    return { behavior: 'deny', message: 'The user dismissed the question without answering.' };
  }
}

function sessionScoped(updates: PermissionUpdate[]): PermissionUpdate[] {
  return updates.map((u) => ({ ...u, destination: 'session' as const }));
}

/** Print-mode host: a fixed answer for every prompt. */
export class PolicyHost implements PromptHost {
  constructor(private readonly allow: boolean) {}
  async ask(req: PromptRequest): Promise<PromptAnswer> {
    if (req.kind === 'plan') return this.allow ? { kind: 'plan-approve', mode: 'default' } : { kind: 'plan-reject' };
    if (req.kind === 'question') {
      const answers: Record<string, string> = {};
      for (const q of req.questions) answers[q.question] = q.options[0]?.label ?? '';
      return { kind: 'answers', answers };
    }
    return this.allow ? { kind: 'allow' } : { kind: 'deny' };
  }
}
