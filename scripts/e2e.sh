#!/usr/bin/env bash
# End-to-end checks against the real API (costs a few cents). Drives the interactive UI
# in a pseudo-terminal with expect, plus one print-mode edit.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${FROSTCODE_E2E_MODEL:-claude-haiku-5-5}"
WORK="$(mktemp -d /tmp/frostcode-e2e.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"
(cd "$ROOT" && npm run build --silent)

echo "== print mode: edit a file"
mkdir -p "$WORK/print"
printf 'def greet(name):\n    return "Hello " + name\n' > "$WORK/print/greet.py"
(cd "$WORK/print" && node "$ROOT/bin/frostcode.js" -p -y -m "$MODEL" \
  "Change greet.py so it returns f\"Hi, {name}!\". Use the Edit tool.")
grep -q 'f"Hi, {name}!"' "$WORK/print/greet.py" && echo "print-mode edit: OK"

echo "== interactive: conversation, approved edit, /cost"
mkdir -p "$WORK/chat"
printf 'The weather is cold today.\nVery cold.\n' > "$WORK/chat/notes.txt"
"$ROOT/scripts/drive.exp" "$WORK/chat" "$WORK/drive.log" "$MODEL" | tail -1
grep -q 'frozen' "$WORK/chat/notes.txt" && echo "interactive edit: OK"

echo "== interactive: plan mode, model picker, resume/codex/context/status"
"$ROOT/scripts/features.exp" "$WORK/chat" "$WORK/features.log" | tail -1
grep -q 'icy' "$WORK/chat/notes.txt" && echo "plan-mode edit: OK"
