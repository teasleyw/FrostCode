import { useEffect, useRef, useState } from 'react';
import type { GuiPrompt, PromptAnswer } from '../protocol.js';
import { Markdown } from './Markdown.js';
import { Diff } from './Transcript.js';

interface Props {
  prompt: GuiPrompt;
  queued: number;
  onAnswer(a: PromptAnswer): void;
}

/** Permission, plan-approval and question prompts, shown above the composer like Claude Code's dialogs. */
export function PromptPanel({ prompt, queued, onAnswer }: Props) {
  return (
    <div className="prompt-panel" role="dialog" aria-label="Claude needs your input">
      {prompt.kind === 'tool' && <ToolPrompt prompt={prompt} onAnswer={onAnswer} />}
      {prompt.kind === 'plan' && <PlanPrompt plan={prompt.plan} onAnswer={onAnswer} />}
      {prompt.kind === 'question' && <QuestionPrompt prompt={prompt} onAnswer={onAnswer} />}
      {queued > 0 && <div className="prompt-queued">+{queued} more waiting</div>}
    </div>
  );
}

/** Number keys pick options while focus is not in a text field. */
function useNumberKeys(handlers: Record<string, () => void>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function ToolPrompt({ prompt, onAnswer }: { prompt: Extract<GuiPrompt, { kind: 'tool' }>; onAnswer(a: PromptAnswer): void }) {
  const [feedback, setFeedback] = useState('');
  const [denying, setDenying] = useState(false);
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!prompt.defaultToNo) firstButton.current?.focus();
  }, [prompt.id, prompt.defaultToNo]);

  const allow = () => onAnswer({ kind: 'allow' });
  const always = () => onAnswer({ kind: 'allow', always: true });
  const deny = () => onAnswer({ kind: 'deny', feedback: feedback.trim() || undefined });
  useNumberKeys({ '1': allow, ...(prompt.allowAlways ? { '2': always } : {}), [prompt.allowAlways ? '3' : '2']: () => setDenying(true) });

  const command = prompt.toolName === 'Bash' && typeof prompt.input.command === 'string' ? prompt.input.command : null;
  const isEdit = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(prompt.toolName);
  const alwaysLabel = isEdit ? 'Yes, allow all edits this session' : `Yes, and don’t ask again for ${prompt.ruleLabel}`;

  return (
    <>
      <div className="prompt-title">
        <span className="prompt-kind">Permission</span>
        {prompt.title ?? `Allow ${prompt.verb ?? prompt.toolName}${prompt.arg ? '' : '?'}`}
      </div>
      {prompt.arg && !command && !prompt.title && <div className="prompt-arg">{prompt.arg}</div>}
      {prompt.description && prompt.description !== prompt.arg && prompt.description !== prompt.title && (
        <div className="prompt-desc">{prompt.description}</div>
      )}
      <div className="prompt-preview">
        {command ? <pre className="tool-pre">{command}</pre> : prompt.diff?.length ? <Diff lines={prompt.diff} /> : <pre className="tool-pre">{JSON.stringify(prompt.input, null, 2)}</pre>}
      </div>
      {prompt.reason && <div className="prompt-reason">{prompt.reason}</div>}
      {denying ? (
        <form
          className="prompt-feedback"
          onSubmit={(e) => {
            e.preventDefault();
            deny();
          }}
        >
          <input
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setDenying(false)}
            placeholder="Tell Claude what to do instead (optional), then Enter"
          />
          <button type="submit" className="btn danger">Deny</button>
        </form>
      ) : (
        <div className="prompt-actions">
          <button ref={firstButton} className="btn primary" onClick={allow}>
            <kbd>1</kbd> Yes
          </button>
          {prompt.allowAlways && (
            <button className="btn" onClick={always}>
              <kbd>2</kbd> {alwaysLabel}
            </button>
          )}
          <button className="btn" onClick={() => setDenying(true)}>
            <kbd>{prompt.allowAlways ? 3 : 2}</kbd> No…
          </button>
        </div>
      )}
    </>
  );
}

function PlanPrompt({ plan, onAnswer }: { plan: string; onAnswer(a: PromptAnswer): void }) {
  const [feedback, setFeedback] = useState('');
  const auto = () => onAnswer({ kind: 'plan-approve', mode: 'acceptEdits' });
  const manual = () => onAnswer({ kind: 'plan-approve', mode: 'default' });
  useNumberKeys({ '1': auto, '2': manual });
  return (
    <>
      <div className="prompt-title">
        <span className="prompt-kind">Plan</span>Ready to code?
      </div>
      <div className="prompt-preview plan">
        <Markdown text={plan || '(empty plan)'} />
      </div>
      <div className="prompt-actions">
        <button className="btn primary" onClick={auto} autoFocus>
          <kbd>1</kbd> Yes, auto-accept edits
        </button>
        <button className="btn" onClick={manual}>
          <kbd>2</kbd> Yes, ask before edits
        </button>
      </div>
      <form
        className="prompt-feedback"
        onSubmit={(e) => {
          e.preventDefault();
          onAnswer({ kind: 'plan-reject', feedback: feedback.trim() || undefined });
        }}
      >
        <input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="No, keep planning — what should change?" />
        <button type="submit" className="btn">Keep planning</button>
      </form>
    </>
  );
}

function QuestionPrompt({ prompt, onAnswer }: { prompt: Extract<GuiPrompt, { kind: 'question' }>; onAnswer(a: PromptAnswer): void }) {
  const [picked, setPicked] = useState<Record<number, Set<number>>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const toggle = (qi: number, oi: number, multi: boolean) => {
    const cur = new Set(multi ? (picked[qi] ?? []) : []);
    if (multi && cur.has(oi)) cur.delete(oi);
    else cur.add(oi);
    setPicked({ ...picked, [qi]: cur });
    if (!multi) setOther({ ...other, [qi]: '' });
  };

  const answerFor = (qi: number): string => {
    const q = prompt.questions[qi];
    const typed = other[qi]?.trim();
    const labels = [...(picked[qi] ?? [])].sort().map((i) => q.options[i].label);
    if (typed) labels.push(typed);
    return labels.join(', ');
  };
  const complete = prompt.questions.every((_, i) => answerFor(i));

  return (
    <>
      <div className="prompt-title">
        <span className="prompt-kind">Question</span>Claude has {prompt.questions.length === 1 ? 'a question' : `${prompt.questions.length} questions`}
      </div>
      <div className="questions">
        {prompt.questions.map((q, qi) => (
          <fieldset key={qi} className="question">
            <legend>
              {q.header && <span className="chip">{q.header}</span>} {q.question}
            </legend>
            <div className="options">
              {q.options.map((o, oi) => {
                const on = picked[qi]?.has(oi) ?? false;
                return (
                  <button key={oi} type="button" className={`option ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(qi, oi, q.multiSelect)}>
                    <span className={`mark ${q.multiSelect ? 'square' : 'round'}`}>{on ? '✓' : ''}</span>
                    <span>
                      <span className="option-label">{o.label}</span>
                      {o.description && <span className="option-desc">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
              <input
                className="option-other"
                value={other[qi] ?? ''}
                onChange={(e) => {
                  setOther({ ...other, [qi]: e.target.value });
                  if (!q.multiSelect && e.target.value) setPicked({ ...picked, [qi]: new Set() });
                }}
                placeholder="Other…"
              />
            </div>
          </fieldset>
        ))}
      </div>
      <div className="prompt-actions">
        <button
          className="btn primary"
          disabled={!complete}
          onClick={() => onAnswer({ kind: 'answers', answers: Object.fromEntries(prompt.questions.map((q, i) => [q.question, answerFor(i)])) })}
        >
          Submit answers
        </button>
        <button className="btn" onClick={() => onAnswer({ kind: 'cancel' })}>
          Skip
        </button>
      </div>
    </>
  );
}
