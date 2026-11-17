import { readFile, lstat, open, rename, unlink, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { emitKeypressEvents } from 'node:readline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const togetherModel = 'Qwen/Qwen3.5-9B';

function dotenvValue(value) {
  if (/[\0\r]/.test(value)) throw new Error('Existing configuration contains unsupported characters. Edit .env manually instead.');
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  throw new Error('Existing configuration has complex quoting. Edit .env manually instead; nothing was changed.');
}

export function togetherConfiguration(existing, apiKey) {
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(apiKey)) {
    throw new Error('Enter a valid Together API key (letters, numbers, underscores or hyphens, 16–512 characters).');
  }
  const values = {
    ...parseEnv(existing),
    MODEL_PROVIDER_NAME: 'Together AI',
    MODEL_BASE_URL: 'https://api.together.ai/v1',
    MODEL_API_KEY: apiKey,
    MODEL_GENERAL: togetherModel,
    MODEL_REASONING: togetherModel,
    MODEL_CODING: togetherModel,
    MODEL_REASONING_ENABLED: 'false',
    MODEL_TIMEOUT_MS: '120000',
    MODEL_MAX_TOKENS: '1800',
  };
  return '# Local server configuration. Contains secrets; do not commit or share.\n'
    + Object.entries(values).map(([key, value]) => `${key}=${dotenvValue(value)}`).join('\n') + '\n';
}

export async function saveTogetherConfiguration(envPath, apiKey) {
  let existing = '';
  try {
    const info = await lstat(envPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The .env path must be a regular file, not a link or directory.');
    existing = await readFile(envPath, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const content = togetherConfiguration(existing, apiKey);
  const temporary = `${envPath}.setup-${randomBytes(8).toString('hex')}`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, envPath);
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function hiddenKey() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run npm run setup:model in an interactive terminal. The API key is entered without echoing it.');
  }
  process.stdout.write('Paste your Together API key (hidden), then press Enter: ');
  emitKeypressEvents(process.stdin);
  const wasRaw = Boolean(process.stdin.isRaw);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolveKey, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolveKey(value);
      value = '';
    };
    const onKey = (text, key = {}) => {
      if ((key.ctrl && ['c', 'd'].includes(key.name)) || key.name === 'escape') return finish(new Error('Setup cancelled. No configuration was changed.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace' || key.name === 'delete') { value = value.slice(0, -1); return; }
      if (!key.ctrl && !key.meta && typeof text === 'string' && /^[A-Za-z0-9_-]+$/.test(text)) {
        if (value.length + text.length > 512) return finish(new Error('The API key is too long. No configuration was changed.'));
        value += text;
      } else if (text && !key.ctrl && !key.meta) {
        return finish(new Error('The API key contains unsupported characters. No configuration was changed.'));
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

async function main() {
  console.log('Nexamiro · Connect Together AI');
  console.log(`This sets all three agent roles to ${togetherModel}, with thinking disabled for the first test.`);
  console.log('Other server settings are preserved. The key is saved only in the local .env file, readable by your user.');
  console.log('Create a key at https://api.together.ai/settings/projects/~current/api-keys');
  const key = await hiddenKey();
  await saveTogetherConfiguration(resolve(root, '.env'), key);
  console.log('\nConfiguration saved. The connection has not been tested yet.');
  console.log('Restart Nexamiro (Ctrl+C in its terminal, then npm start).');
  console.log('Open Models & tools → Test model connection. This makes a small paid test request.');
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
