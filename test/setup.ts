import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep tests away from the real ~/.frostcode and the real API key.
process.env.FROSTCODE_HOME = mkdtempSync(join(tmpdir(), 'frostcode-test-'));
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-0123456789abcdef';
