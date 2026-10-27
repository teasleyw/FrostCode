import { query } from '@anthropic-ai/claude-agent-sdk';
import { prepareProcessEnv, buildAgentEnv, redact } from '../src/config/env.js';
prepareProcessEnv();
const t0 = Date.now();
const q = query({ prompt: 'Reply with exactly: pong', options: { env: buildAgentEnv(), model: 'claude-haiku-5-5', permissionMode: 'default', maxTurns: 1, cwd: process.cwd(), settingSources: [], persistSession: false, stderr: (d) => process.stderr.write('[stderr] ' + redact(d)) } });
for await (const m of q) {
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (m.type === 'system' && m.subtype === 'init') console.log(dt, 'init', m.apiKeySource, m.model, m.claude_code_version, m.tools.length, 'tools');
  else if (m.type === 'assistant') console.log(dt, 'assistant', JSON.stringify(m.message.content).slice(0, 200));
  else if (m.type === 'result') console.log(dt, 'result', m.subtype, m.total_cost_usd, Object.keys(m.modelUsage));
  else console.log(dt, m.type, (m as any).subtype ?? '');
}
