import { addAccount, listAccounts, removeAccount, useAccount } from '../config/accounts.js';

const USAGE = `frostcode account [list]           list API accounts (● = active)
frostcode account add <name>       save a key under a name (prompts hidden, or pipe it on stdin)
frostcode account use <name>       make it the active account (also: /account <name> in a session)
frostcode account remove <name>    forget a saved key

"env" is the built-in account for the shell's ANTHROPIC_API_KEY.`;

/** `frostcode account ...`: keys are read from a hidden prompt or stdin, never from argv. */
export async function runAccountCommand(argv: string[]): Promise<number> {
  const [sub = 'list', name] = argv;
  try {
    if (sub === 'list') {
      for (const a of listAccounts()) console.log(`${a.active ? '●' : ' '} ${a.name}${a.available ? '' : ' (ANTHROPIC_API_KEY not set)'}`);
      return 0;
    }
    if (sub === 'add' && name) {
      const key = process.stdin.isTTY ? await readHidden(`API key for "${name}": `) : await readAll();
      addAccount(name, key);
      console.log(`Saved account "${name}". Switch to it with /account ${name} or: frostcode account use ${name}`);
      return 0;
    }
    if (sub === 'use' && name) {
      useAccount(name);
      console.log(`Active account: ${name}`);
      return 0;
    }
    if ((sub === 'remove' || sub === 'rm') && name) {
      removeAccount(name);
      console.log(`Removed account "${name}".`);
      return 0;
    }
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  console.log(USAGE);
  return sub === '-h' || sub === '--help' ? 0 : 2;
}

function readAll(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
