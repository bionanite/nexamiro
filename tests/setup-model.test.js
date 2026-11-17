import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { togetherConfiguration, saveTogetherConfiguration } from '../scripts/setup-model.js';

const key = 'synthetic-test-key-not-a-real-secret';

test('Together setup preserves unrelated settings and round-trips private values', () => {
  const existing = "ACCESS_TOKEN='keep-me-private'\nPORT=9000\nNOTE='first\nsecond # literal'\nPATH_HINT='a\\n'\nMODEL_API_KEY=old\n";
  const values = parseEnv(togetherConfiguration(existing, key));
  assert.equal(values.ACCESS_TOKEN, 'keep-me-private');
  assert.equal(values.PORT, '9000');
  assert.equal(values.NOTE, 'first\nsecond # literal');
  assert.equal(values.PATH_HINT, 'a\\n');
  assert.equal(values.MODEL_API_KEY, key);
  assert.equal(values.MODEL_GENERAL, 'Qwen/Qwen3.5-9B');
  assert.equal(values.MODEL_REASONING_ENABLED, 'false');
  assert.throws(() => togetherConfiguration('', 'bad\nMODEL_BASE_URL=evil'), /valid Together API key/);
});

test('Together setup writes private permissions, avoids symlinks, and leaves invalid setup untouched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nexamiro-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = join(directory, '.env');
  await writeFile(envPath, 'PORT=9000\n', { mode: 0o644 });
  await saveTogetherConfiguration(envPath, key);
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  const saved = await readFile(envPath, 'utf8');
  assert.equal(parseEnv(saved).PORT, '9000');
  await assert.rejects(saveTogetherConfiguration(envPath, ''), /valid Together API key/);
  assert.equal(await readFile(envPath, 'utf8'), saved);
  const link = join(directory, 'linked.env');
  await symlink(envPath, link);
  await assert.rejects(saveTogetherConfiguration(link, key), /regular file/);
  assert.deepEqual((await readdir(directory)).sort(), ['.env', 'linked.env']);
});
