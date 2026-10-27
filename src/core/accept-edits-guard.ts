import type { HookCallback, HookCallbackMatcher, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/**
 * Commands the runtime's acceptEdits mode may approve on its own, without calling canUseTool,
 * when they touch files inside the working directory. Auto-accept in FrostCode covers edit
 * tools only, so a Bash call that runs any of these is sent back through the normal prompt.
 */
const FILESYSTEM_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed', 'ln', 'chmod', 'tee', 'truncate', 'install', 'dd']);

/** The same for the PowerShell tool on Windows: cmdlets and their aliases, lower-cased (PowerShell ignores case). */
const POWERSHELL_FILESYSTEM_COMMANDS = new Set([
  ...['remove-item', 'move-item', 'copy-item', 'new-item', 'rename-item', 'set-content', 'add-content', 'clear-content', 'out-file', 'tee-object', 'expand-archive'],
  ...['rm', 'rmdir', 'del', 'erase', 'rd', 'ri', 'mv', 'move', 'mi', 'cp', 'copy', 'cpi', 'ni', 'mkdir', 'md', 'ren', 'rni', 'sc', 'ac', 'clc', 'tee'],
]);

/** True when any simple command in a shell line starts with a filesystem-changing command. */
export function runsFilesystemCommand(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|&\n()`]|\$\(/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    // Skip leading VAR=value assignments and wrappers that run the next word.
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ['sudo', 'env', 'command', 'nice', 'nohup', 'time', 'xargs'].includes(words[i]))) i++;
    const word = words[i];
    if (word && FILESYSTEM_COMMANDS.has(word.split('/').pop()!)) return true;
  }
  return false;
}

/** runsFilesystemCommand for a PowerShell line: script blocks ({ }) and the call operator (&) start commands too. */
export function runsPowerShellFilesystemCommand(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|&\r\n(){}]|\$\(/)) {
    const word = segment.trim().split(/\s+/)[0];
    if (word && POWERSHELL_FILESYSTEM_COMMANDS.has(word.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, ''))) return true;
  }
  return false;
}

/**
 * PreToolUse hook that keeps shell commands under normal approval while acceptEdits is on.
 * It never allows anything: it either says nothing (normal rules apply) or forces "ask",
 * which routes the call to FrostCode's canUseTool prompt.
 */
export function acceptEditsShellGuard(currentMode: () => PermissionMode): HookCallbackMatcher {
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell')) return {};
    const mode = input.permission_mode ?? currentMode();
    if (mode !== 'acceptEdits' && currentMode() !== 'acceptEdits') return {};
    const command = (input.tool_input as { command?: unknown } | null)?.command;
    const changesFiles = input.tool_name === 'PowerShell' ? runsPowerShellFilesystemCommand : runsFilesystemCommand;
    if (typeof command !== 'string' || !changesFiles(command)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'Auto-accept edits covers file edit tools only; shell commands still need approval.',
      },
    };
  };
  return { matcher: 'Bash|PowerShell', hooks: [hook] };
}
