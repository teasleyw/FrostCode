# FrostCode

An interactive terminal coding assistant in the style of Claude Code, built on the official
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) (`@anthropic-ai/claude-agent-sdk`)
with an [Ink](https://github.com/vadimdemedes/ink) interface. It authenticates **only** with
`ANTHROPIC_API_KEY`, so all usage is billed to your Anthropic API account, not a Claude subscription.

```
╭────────────────────────────────────────────╮
│ ✻ Welcome to FrostCode  v0.1.0             │
│   /help for help, /status for your setup   │
╰────────────────────────────────────────────╯
> Edit notes.txt: replace cold with frozen

● Read(notes.txt)
  ⎿  Read 2 lines
● Update(notes.txt)
  ⎿  Updated notes.txt with 2 additions and 2 removals
       1 - The weather is cold today.
       1 + The weather is frozen today.
```

## Install

Requirements: Node.js 20+, macOS, Linux or Windows, an Anthropic API key.

```bash
cd frostcode
npm install          # also builds dist/ via the prepare script
npm link             # puts `frostcode` on your PATH (undo with: npm unlink -g frostcode)
export ANTHROPIC_API_KEY=sk-ant-...
frostcode
```

Without `npm link`, run `./bin/frostcode.js` or `npm run dev` (runs from source with tsx).

### Windows

The same steps work in PowerShell; only setting the key differs:

```powershell
cd FrostCode
npm install
npm link
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # this window only; setx ANTHROPIC_API_KEY sk-ant-... for new windows
frostcode                                # or: frostcode gui
```

- The agent runtime gives Claude a **PowerShell** tool on Windows, and a **Bash** tool too when Git for
  Windows (Git Bash) is installed. Permission rules treat both alike: "don't ask again" is scoped to the
  command's first word and never approves a chained command.
- Saved account keys (`frostcode account add`) go to `%USERPROFILE%\.frostcode\account-keys.json`,
  protected by your user profile's permissions (there is no Keychain).
- The desktop app opens with `frostcode gui`, or install it as a Windows app with
  `npm run install-app`: a FrostCode shortcut in the Start menu and on the desktop, with the snowflake
  icon on the taskbar (pin it from there). Rebuilding updates it; delete the two shortcuts to remove it.
  Opened without a key, the app asks for one: it is checked with Anthropic and saved as the `default`
  account (the same store as `frostcode account add`), so nothing has to be set in the environment.
- `npm run e2e` (bash + expect) is macOS / Linux only.

## Usage

```
frostcode [options] [prompt]          interactive session (optionally with a first prompt)
frostcode -p "prompt" [-y]            one prompt, printed, then exit (-y approves tool prompts)
frostcode codex [all|show <id>]       list unfinished OpenAI Codex sessions (read-only)

-m, --model <id>                      claude-opus-5-5, claude-sonnet-5-5, haiku, ...
-C, --cwd <dir>                       project directory
-c, --continue                        continue the latest conversation in this project
-r, --resume [id]                     resume a conversation (picker without an id)
    --plan | --permission-mode <m>    default | acceptEdits | plan | bypassPermissions
    --dangerously-skip-permissions    enable bypass mode
    --output-format stream-json       with -p: raw SDK messages as JSON lines
```

### In the session

| Key | Action |
| --- | --- |
| `enter` | send (while Claude works, the message is queued) |
| `\` then `enter`, or `alt+enter` | newline |
| `esc` | interrupt Claude / dismiss a dialog |
| `shift+tab` | cycle permission mode: default → accept edits → plan |
| `↑` / `↓` | prompt history (or move in suggestions) |
| `tab` | complete a slash command |
| `ctrl+c` | clear input / interrupt; twice on an empty prompt to exit |
| `?` | show shortcuts |

| Command | |
| --- | --- |
| `/help` | commands and shortcuts |
| `/model [id]` | switch model mid-conversation (picker lists the models the runtime offers) |
| `/plan`, `/mode [mode]` | plan mode toggle / set permission mode |
| `/resume [id]`, `/clear` | resume a saved conversation / start a new one |
| `/project [path]` | switch project directory (recent-projects picker) |
| `/compact [focus]`, `/context` | summarize to free context / show context usage |
| `/cost`, `/status` | tokens and estimated USD for the session / setup and auth source |
| `/permissions [clear]` | tools you allowed for this session |
| `/codex [all\|show\|import]` | browse unfinished Codex sessions and hand one to Claude |
| `/mcp [...]` | manage MCP servers (see below) |
| `/rename <title>`, `/exit` | name the session / quit |

Commands the agent runtime provides (custom `.claude/commands`, skills) are passed through.

## How it works

- **Agent loop**: one `query()` per conversation in streaming-input mode. User turns go in through an
  async queue, so the session stays alive between turns; `interrupt()`, `setModel()` and
  `setPermissionMode()` act on the live session. Partial messages stream text as it is generated.
- **Tools**: the SDK's Claude Code toolset (Read, Edit, Write, Bash, Grep, Glob, WebFetch, subagents, …)
  with `CLAUDE.md` and `.claude/settings.json` from the project.
- **Permissions**: FrostCode's `canUseTool` shows Claude Code-style prompts with a diff preview for edits
  (real file line numbers), "don't ask again" session rules (Bash rules are scoped to the command and
  never match chained commands), and feedback on "No". It also answers `ExitPlanMode` (plan approval)
  and `AskUserQuestion`.
- **Sessions**: transcripts are saved by the runtime and listed/loaded with the SDK's `listSessions` /
  `getSessionMessages`; `--resume`, `--continue` and `/resume` reload the visible history.
- **Cost**: the SDK's `total_cost_usd` is cumulative within a session, so the latest result is the
  session total; FrostCode stores each session's last total in `~/.frostcode/costs.json` so a resumed
  session can tell restored spend from new spend. The status line shows model, context %, tokens and $.
  These are SDK estimates — the Claude Console usage page is authoritative.

### API-key billing and isolation

FrostCode runs the SDK's runtime with its **own config directory** (`~/.frostcode/agent`, passed as
`CLAUDE_CONFIG_DIR`) and strips `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock/Vertex
switches from its environment. The runtime therefore never sees a Claude subscription login and
authenticates with `ANTHROPIC_API_KEY`; the handshake's reported credential source is checked and
shown in `/status` (a project `apiKeyHelper` would trigger a warning). The key is never written to
disk or logs: errors, stderr and prompt history pass through a redactor.

### Multiple API accounts

Save a key per Anthropic Console account and switch between them without leaving the conversation:

```bash
frostcode account add work        # prompts for the key (hidden), or pipe it on stdin
frostcode account add personal
frostcode account list            # ● marks the active one; "env" is the shell's ANTHROPIC_API_KEY
```

In a session (terminal or desktop app), `/account` lists them and `/account work` switches: the runtime
restarts on the new key and resumes the same conversation. The choice is remembered for the next launch
(`frostcode account use <name>` sets it from a shell). Saved keys live in the macOS login Keychain
(service `frostcode-account`), or `~/.frostcode/account-keys.json` (mode 600; on Windows, guarded by
the user profile's permissions) on other systems;
`~/.frostcode/accounts.json` holds only the names.

FrostCode does not run the interactive Claude Code CLI. The Agent SDK itself drives its bundled agent
runtime as a headless subprocess over a JSON protocol; that is how the official SDK works.

### MCP servers

FrostCode reuses the MCP servers you already configured; it never edits those files.

- **Where servers come from** (closest wins when two share a name): `~/.claude.json` project servers
  (Claude Code's local scope), the nearest `.mcp.json`, `~/.claude.json` user servers, the Claude
  desktop app's installed extensions (e.g. Blender Lab's Blender MCP), then `claude_desktop_config.json`.
  stdio, HTTP and SSE servers are supported.
- **Approval first**: a newly found server stays disconnected until you approve it (`/mcp`, or the
  **MCP** button in the desktop app). Approval is tied to the server's command / URL / env; if that
  changes, it asks again. Decisions live in `~/.frostcode/mcp.json`.
- **Connection** goes through the Agent SDK (`mcpServers` with `strictMcpConfig`, then
  `setMcpServers` / `toggleMcpServer` / `reconnectMcpServer` / `mcpServerStatus`), so nothing you have
  not approved connects on its own.
- **Sensitive tools**: any MCP tool not marked read-only by its server asks before *each* call, in
  every mode (Auto and Auto-edit included), with no "don't ask again". Read-only tools follow the
  normal permission prompts. You can mark a tool trusted on the server's tools page.
- **In the conversation** MCP calls show as `server · tool (MCP)` with their result.

`/mcp` opens the manager; `/mcp list`, `/mcp approve|reject|enable|disable|reconnect|tools <server>`,
`/mcp trust|untrust <server> <tool>` and `/mcp refresh` do the same from the prompt.

### OpenAI Codex sessions

`/codex` (or `frostcode codex`) scans `~/.codex/sessions/**/rollout-*.jsonl` and lists sessions whose
last turn never finished (open turn, interrupted turn, or a tool call with no output). Helper threads
(e.g. auto-review guardians) are hidden. Files are only ever opened for reading. "Continue it here"
sends Claude a handoff message with the original request, Codex's last reply, unanswered tool calls
and recent activity; "Switch to … and continue" opens the session's own project first.

## Files

| Path | Contents |
| --- | --- |
| `~/.frostcode/agent/` | runtime config dir: transcripts (`projects/`), plans |
| `~/.frostcode/costs.json` | last known cost per session |
| `~/.frostcode/mcp.json` | MCP server approvals and trusted tools |
| `~/.frostcode/projects.json` | recent projects |
| `~/.frostcode/prompt-history.json` | prompt history (redacted) |

Set `FROSTCODE_HOME` to move all of it.

## Development

```bash
npm run typecheck
npm test             # unit + component tests (no network, fake SDK)
npm run e2e          # real API, ~$0.05: drives the TUI in a pty with expect
npm run smoke        # one tiny real query; prints the credential source
```

Layout: `src/core` (session, transcript reducer, permissions, cost, history, projects),
`src/codex` (read-only Codex log reader), `src/commands` (slash commands), `src/app` (controller,
print mode), `src/ui` (Ink components), `test/`, `scripts/` (expect drivers).
