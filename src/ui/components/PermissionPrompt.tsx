import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { isShellTool, type PromptAnswer, type PromptRequest, type QuestionSpec } from '../../core/permissions.js';
import { renderMarkdown } from '../markdown.js';
import { displayPath, proposedPatch, toolHeader } from '../tools.js';
import { DiffView } from './Diff.js';
import { theme } from '../theme.js';

interface Props {
  request: PromptRequest;
  cwd: string;
  width: number;
  onAnswer(answer: PromptAnswer): void;
}

export function PermissionPrompt(props: Props) {
  const { request } = props;
  if (request.kind === 'plan') return <PlanPrompt {...props} request={request} />;
  if (request.kind === 'question') return <QuestionPrompt {...props} request={request} />;
  return <ToolPrompt {...props} request={request} />;
}

interface Option {
  label: string;
  answer: PromptAnswer | 'feedback';
}

/** Numbered option list with arrows, number keys and an optional inline feedback field. */
function Options({
  options,
  initial = 0,
  onAnswer,
  feedbackPlaceholder,
  makeFeedback,
}: {
  options: Option[];
  initial?: number;
  onAnswer(a: PromptAnswer): void;
  feedbackPlaceholder: string;
  makeFeedback(text: string): PromptAnswer;
}) {
  const [index, setIndex] = useState(initial);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');

  useInput((input, key) => {
    if (typing) {
      if (key.escape) {
        setTyping(false);
        return;
      }
      if (key.return) return onAnswer(makeFeedback(text));
      if (key.backspace || key.delete) return setText((t) => t.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setText((t) => t + input.replace(/[\r\n]/g, ' '));
      return;
    }
    if (key.escape) return onAnswer(makeFeedback(''));
    if (key.upArrow) return setIndex((i) => (i <= 0 ? options.length - 1 : i - 1));
    if (key.downArrow || key.tab) return setIndex((i) => (i >= options.length - 1 ? 0 : i + 1));
    const choose = (i: number) => {
      const opt = options[i];
      if (!opt) return;
      if (opt.answer === 'feedback') {
        setIndex(i);
        setTyping(true);
      } else onAnswer(opt.answer);
    };
    if (key.return) return choose(index);
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) choose(n - 1);
  });

  return (
    <Box flexDirection="column">
      {options.map((o, i) => (
        <Box key={i}>
          <Text color={i === index ? theme.accent : undefined}>{i === index ? '❯ ' : '  '}</Text>
          <Text color={i === index ? theme.accent : undefined}>{`${i + 1}. ${o.label}`}</Text>
        </Box>
      ))}
      {typing ? (
        <Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
          <Text>{'> '}</Text>
          {text ? <Text>{text}</Text> : <Text dimColor>{feedbackPlaceholder}</Text>}
          <Text inverse>{' '}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ToolPrompt({ request, cwd, width, onAnswer }: Props & { request: Extract<PromptRequest, { kind: 'tool' }> }) {
  const { toolName, input } = request;
  const isEdit = toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit';
  const file = typeof input.file_path === 'string' ? displayPath(input.file_path, cwd) : '';
  const { verb, arg } = toolHeader(toolName, input, cwd);
  const isShell = isShellTool(toolName);
  const title =
    isShell ? `${toolName} command` : isEdit ? (toolName === 'Write' ? 'Create file' : 'Edit file') : request.title || `${verb} tool`;
  const question = isEdit ? `Do you want to make this edit to ${file}?` : 'Do you want to proceed?';
  const alwaysLabel = isEdit
    ? 'Yes, allow all edits during this session'
    : isShell
      ? `Yes, and don't ask again for ${request.ruleLabel.replace(/^\w+\((.*):\*\)$/, '$1')} commands this session`
      : `Yes, and don't ask again for ${verb} this session`;
  const options: Option[] = [{ label: request.sensitive ? 'Yes, run this call' : 'Yes', answer: { kind: 'allow' } }];
  if (request.allowAlways) options.push({ label: alwaysLabel, answer: { kind: 'allow', always: true } });
  options.push({ label: 'No, and tell Claude what to do differently (esc)', answer: 'feedback' });

  let hunks: ReturnType<typeof proposedPatch> = [];
  if (isEdit && toolName !== 'NotebookEdit') {
    try {
      hunks = proposedPatch(toolName, input, cwd);
    } catch {
      hunks = [];
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={width}>
      <Text bold color={theme.accent}>
        {title}
      </Text>
      <Box flexDirection="column" marginY={1} marginLeft={2}>
        {isShell ? (
          <>
            <Text>{String(input.command ?? '')}</Text>
            {input.description ? <Text dimColor>{String(input.description)}</Text> : null}
          </>
        ) : isEdit ? (
          <>
            <Text bold>{file}</Text>
            <DiffView hunks={hunks} width={width - 6} maxLines={30} />
          </>
        ) : (
          <>
            <Text>{`${verb}(${arg})`}</Text>
            {request.description ? <Text dimColor>{request.description}</Text> : null}
            {Object.keys(input).length ? <Text dimColor>{truncateJson(input, 600)}</Text> : null}
          </>
        )}
        {request.reason ? <Text color={theme.warning}>{request.reason}</Text> : null}
      </Box>
      <Text>{question}</Text>
      <Options
        options={options}
        initial={request.defaultToNo ? options.length - 1 : 0}
        onAnswer={onAnswer}
        feedbackPlaceholder="tell Claude what to do instead (enter to send, esc to go back)"
        makeFeedback={(t) => ({ kind: 'deny', feedback: t })}
      />
    </Box>
  );
}

function PlanPrompt({ request, width, onAnswer }: Props & { request: Extract<PromptRequest, { kind: 'plan' }> }) {
  const lines = request.plan.split('\n');
  const shown = lines.length > 40 ? [...lines.slice(0, 40), `… ${lines.length - 40} more lines`].join('\n') : request.plan;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.plan} paddingX={1} width={width}>
      <Text bold color={theme.plan}>
        Ready to code?
      </Text>
      <Text dimColor>Here is Claude's plan:</Text>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginY={1} flexDirection="column">
        <Text>{renderMarkdown(shown)}</Text>
      </Box>
      <Text>Would you like to proceed?</Text>
      <Options
        options={[
          { label: 'Yes, and auto-accept edits', answer: { kind: 'plan-approve', mode: 'acceptEdits' } },
          { label: 'Yes, and manually approve edits', answer: { kind: 'plan-approve', mode: 'default' } },
          { label: 'No, keep planning (tell Claude what to change)', answer: 'feedback' },
        ]}
        onAnswer={onAnswer}
        feedbackPlaceholder="what should change in the plan?"
        makeFeedback={(t) => ({ kind: 'plan-reject', feedback: t })}
      />
    </Box>
  );
}

function QuestionPrompt({ request, width, onAnswer }: Props & { request: Extract<PromptRequest, { kind: 'question' }> }) {
  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const q: QuestionSpec | undefined = request.questions[qIndex];
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [other, setOther] = useState<string | null>(null);

  const options = q ? [...q.options.map((o) => o.label), 'Other (type your own answer)'] : [];

  useEffect(() => {
    if (!q) onAnswer({ kind: 'answers', answers });
  }, [q]);

  const commit = (answer: string) => {
    if (!q) return;
    const next = { ...answers, [q.question]: answer };
    setAnswers(next);
    setPicked(new Set());
    setCursor(0);
    setOther(null);
    if (qIndex + 1 >= request.questions.length) onAnswer({ kind: 'answers', answers: next });
    else setQIndex(qIndex + 1);
  };

  useInput((input, key) => {
    if (!q) return;
    if (other !== null) {
      if (key.escape) return setOther(null);
      if (key.return) return other.trim() ? commit(other.trim()) : undefined;
      if (key.backspace || key.delete) return setOther((t) => (t ?? '').slice(0, -1));
      if (input && !key.ctrl && !key.meta) setOther((t) => (t ?? '') + input.replace(/[\r\n]/g, ' '));
      return;
    }
    if (key.escape) return onAnswer({ kind: 'cancel' });
    if (key.upArrow) return setCursor((i) => (i <= 0 ? options.length - 1 : i - 1));
    if (key.downArrow) return setCursor((i) => (i >= options.length - 1 ? 0 : i + 1));
    const isOther = (i: number) => i === options.length - 1;
    if (q.multiSelect && input === ' ' && !isOther(cursor)) {
      const next = new Set(picked);
      if (next.has(cursor)) next.delete(cursor);
      else next.add(cursor);
      return setPicked(next);
    }
    const choose = (i: number) => {
      if (isOther(i)) return setOther('');
      if (q.multiSelect) {
        const set = picked.size ? picked : new Set([i]);
        commit([...set].sort().map((j) => q.options[j].label).join(', '));
      } else commit(q.options[i].label);
    };
    if (key.return) return choose(cursor);
    const n = Number(input);
    if (!q.multiSelect && Number.isInteger(n) && n >= 1 && n <= options.length) choose(n - 1);
  });

  if (!q) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={width}>
      <Text bold color={theme.accent}>
        {`${q.header || 'Question'}${request.questions.length > 1 ? ` (${qIndex + 1}/${request.questions.length})` : ''}`}
      </Text>
      <Box marginY={1}>
        <Text>{q.question}</Text>
      </Box>
      {options.map((label, i) => {
        const desc = q.options[i]?.description;
        const mark = q.multiSelect && i < q.options.length ? (picked.has(i) ? '[x] ' : '[ ] ') : '';
        return (
          <Box key={i} flexDirection="column">
            <Text color={i === cursor ? theme.accent : undefined}>{`${i === cursor ? '❯' : ' '} ${i + 1}. ${mark}${label}`}</Text>
            {desc ? <Text dimColor>{`      ${desc}`}</Text> : null}
          </Box>
        );
      })}
      {other !== null ? (
        <Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
          <Text>{'> '}</Text>
          {other ? <Text>{other}</Text> : <Text dimColor>type your answer</Text>}
          <Text inverse>{' '}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>{q.multiSelect ? 'space to toggle · enter to confirm · esc to dismiss' : 'enter to select · esc to dismiss'}</Text>
      </Box>
    </Box>
  );
}

function truncateJson(v: unknown, n: number): string {
  const s = JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
