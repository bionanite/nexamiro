import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createEngine } from '../backend/engine.js';
import { createProvider } from '../backend/provider.js';
import { createStore } from '../backend/store.js';

async function workspace(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nexamiro-engine-'));
  const engine = await createEngine({ dataDir, env: {}, demoDelayMs: 1, ...options });
  t.after(async () => { await engine.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { engine, dataDir };
}

async function finished(engine, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = engine.getTask(id);
    if (!['queued', 'running'].includes(task.status)) return task;
    await delay(10);
  }
  throw new Error('Run did not finish within the test deadline.');
}

const liveEnv = { MODEL_BASE_URL: 'http://localhost:11434/v1', MODEL_GENERAL: 'general-model', MODEL_REASONING: 'reasoning-model', MODEL_CODING: 'coding-model', MODEL_API_KEY: 'test-secret-never-echo' };
const completion = (content = 'A grounded answer [1].') => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }), { headers: { 'Content-Type': 'application/json' } });

test('demo run completes three visible stages without calling a model and survives restart', async t => {
  const { engine, dataDir } = await workspace(t, { fetchImpl: () => { throw new Error('Demo must never call fetch'); } });
  const task = await engine.createTask({ prompt: 'Plan our next product release', mode: 'auto' });
  const result = await finished(engine, task.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.executionMode, 'demo');
  assert.equal(result.route, 'reasoning');
  assert.ok(result.steps.every(step => step.status === 'completed'));
  assert.match(result.answer, /No language model was called/);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
  await engine.close();
  const reopened = await createEngine({ dataDir, env: {} });
  assert.equal(reopened.getTask(task.id).answer, result.answer);
  await reopened.close();
});

test('knowledge search is scoped to selected documents and returns real excerpts', async t => {
  const { engine } = await workspace(t);
  const first = await engine.addDocument({ name: 'Alpha.md', text: 'Alpha launch requires compliance approval. Launch owner: Priya.' });
  await engine.addDocument({ name: 'Beta.md', text: 'Beta launch requires finance approval. Launch owner: Sam.' });
  assert.equal(engine.status().knowledge.mode, 'lexical');
  const scoped = engine.searchKnowledge('launch approval', [first.id]);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].name, 'Alpha.md');
  assert.match(scoped[0].excerpt, /Priya/);
  assert.deepEqual(engine.searchKnowledge('launch', []), []);
  assert.deepEqual(engine.searchKnowledge('unmatched gibberish'), []);
  const created = await engine.createTask({ prompt: 'Summarize launch approval', documentIds: [first.id] });
  const task = await finished(engine, created.id);
  assert.equal(task.sources[0].documentId, first.id);
  assert.match(task.answer, /Priya/);
  const detached = engine.getTask(task.id);
  detached.answer = 'mutated';
  assert.notEqual(engine.getTask(task.id).answer, 'mutated');
});

test('live workflow routes each stage and preserves source context and usage', async t => {
  const requests = [];
  const { engine } = await workspace(t, { env: liveEnv, fetchImpl: async (url, options) => {
    requests.push({ url: url.toString(), ...options, body: JSON.parse(options.body) });
    return completion(`Agent response ${requests.length} [1].`);
  } });
  const document = await engine.addDocument({ name: 'API.md', text: 'The billing API uses an idempotency key on every write.' });
  const queued = await engine.createTask({ prompt: 'Implement a client for the billing API', documentIds: [document.id] });
  const task = await finished(engine, queued.id);
  assert.equal(task.status, 'completed');
  assert.equal(task.route, 'coding');
  assert.deepEqual(requests.map(request => request.body.model), ['general-model', 'coding-model', 'reasoning-model']);
  assert.equal(requests[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(requests[0].headers.Authorization, 'Bearer test-secret-never-echo');
  assert.match(requests[0].body.messages[0].content, /untrusted/);
  assert.match(requests[1].body.messages[1].content, /idempotency/);
  assert.match(requests[2].body.messages[1].content, /Agent response 2/);
  assert.equal(task.answer, 'Agent response 3 [1].');
  assert.deepEqual(task.usage, { inputTokens: 36, outputTokens: 21 });
  assert.doesNotMatch(JSON.stringify(engine.status()), /test-secret/);
});

test('broad requests include bounded selected-document excerpts when lexical search has no match', async t => {
  const { engine } = await workspace(t);
  const document = await engine.addDocument({ name: 'Release.md', text: 'Alpha rollout begins Monday. Priya owns launch readiness.' });
  assert.deepEqual(engine.searchKnowledge('Summarize the selected documents', [document.id]), []);
  const created = await engine.createTask({ prompt: 'Summarize the selected documents', documentIds: [document.id] });
  const task = await finished(engine, created.id);
  assert.equal(task.sources[0].retrieval, 'selected_excerpt');
  assert.equal(task.sources[0].score, 0);
  assert.match(task.sources[0].excerpt, /Alpha rollout/);
  assert.match(task.contextNotice, /full documents were not read/);
  assert.match(task.answer, /Priya/);
});

test('provider failures stop the run without exposing response bodies or credentials', async t => {
  let calls = 0;
  const { engine } = await workspace(t, { env: liveEnv, fetchImpl: async () => {
    calls++;
    return new Response('Sensitive debug dump test-secret-never-echo', { status: 401 });
  } });
  const queued = await engine.createTask({ prompt: 'Analyze this request' });
  const task = await finished(engine, queued.id);
  assert.equal(task.status, 'failed');
  assert.equal(calls, 1);
  assert.match(task.error, /HTTP 401/);
  assert.doesNotMatch(JSON.stringify(task), /test-secret|Sensitive debug/);
  assert.equal(task.answer, '');
});

test('cancellation aborts a running model request and allows a queued run to start', async t => {
  let aborts = 0;
  let calls = 0;
  const { engine } = await workspace(t, { env: liveEnv, concurrency: 1, fetchImpl: async (_url, { signal }) => {
    calls++;
    if (calls === 1) return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborts++; reject(new DOMException('cancelled', 'AbortError')); }, { once: true });
    });
    return completion();
  } });
  const first = await engine.createTask({ prompt: 'First task' });
  while (!calls) await delay(1);
  const second = await engine.createTask({ prompt: 'Second task' });
  assert.equal(engine.getTask(second.id).status, 'queued');
  await engine.cancelTask(first.id);
  const result = await finished(engine, second.id);
  assert.equal(engine.getTask(first.id).status, 'cancelled');
  assert.equal(aborts, 1);
  assert.equal(result.status, 'completed');
});

test('queued cancellation never invokes a provider and active documents cannot be deleted', async t => {
  const { engine } = await workspace(t, { concurrency: 1, demoDelayMs: 100 });
  const doc = await engine.addDocument({ name: 'Policy.txt', text: 'A retention policy for knowledge documents.' });
  const first = await engine.createTask({ prompt: 'Review policy', documentIds: [doc.id] });
  const second = await engine.createTask({ prompt: 'Queued policy task' });
  await assert.rejects(engine.deleteDocument(doc.id), { statusCode: 409 });
  await engine.cancelTask(second.id);
  await engine.cancelTask(first.id);
  assert.equal(engine.getTask(second.id).status, 'cancelled');
  assert.ok(engine.getTask(second.id).steps.every(step => step.status === 'cancelled'));
  await engine.deleteDocument(doc.id);
  assert.equal(engine.listDocuments().length, 0);
});

test('retry creates a new task and restart never replays unfinished work', async t => {
  const { engine, dataDir } = await workspace(t);
  const first = await engine.createTask({ prompt: 'Review release readiness' });
  await finished(engine, first.id);
  const retry = await engine.retryTask(first.id);
  assert.notEqual(retry.id, first.id);
  await finished(engine, retry.id);
  await engine.close();
  const state = JSON.parse(await readFile(join(dataDir, 'workspace.json'), 'utf8'));
  state.tasks[0].status = 'running';
  state.tasks[0].steps[0].status = 'running';
  await writeFile(join(dataDir, 'workspace.json'), JSON.stringify(state));
  let calls = 0;
  const reopened = await createEngine({ dataDir, env: liveEnv, fetchImpl: async () => { calls++; return completion(); } });
  const recovered = reopened.getTask(first.id);
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error, /interrupted.*restart/);
  assert.equal(calls, 0);
  await reopened.close();
});

test('validation rejects malformed inputs before they enter durable state', async t => {
  const { engine } = await workspace(t);
  await assert.rejects(engine.createTask({ prompt: 'x'.repeat(16001) }), { statusCode: 400 });
  await assert.rejects(engine.createTask({ prompt: 'Valid', mode: 'shell' }), { statusCode: 400 });
  await assert.rejects(engine.createTask({ prompt: 'Valid', documentIds: ['missing'] }), { statusCode: 404 });
  await assert.rejects(engine.addDocument({ name: 'large.txt', text: 'x'.repeat(200001) }), { statusCode: 400 });
  await assert.rejects(engine.addDocument({ name: '', text: 'some content' }), { statusCode: 400 });
  assert.throws(() => engine.searchKnowledge(''), { statusCode: 400 });
  assert.equal(engine.listTasks().length, 0);
  assert.equal(engine.listDocuments().length, 0);
});

test('invalid persistent JSON is preserved and never silently replaced', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nexamiro-invalid-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, 'workspace.json'), '{broken');
  await assert.rejects(createEngine({ dataDir, env: {} }), /existing file has been preserved/);
  assert.equal(await readFile(join(dataDir, 'workspace.json'), 'utf8'), '{broken');
});

test('provider rejects unsafe URL forms, partial configuration, and non-text output', async () => {
  assert.throws(() => createProvider({ env: { MODEL_BASE_URL: 'http://localhost/v1' } }), /both MODEL_BASE_URL/);
  assert.throws(() => createProvider({ env: { ...liveEnv, MODEL_BASE_URL: 'https://user:pass@example.com/v1' } }), /without credentials/);
  assert.throws(() => createProvider({ env: { ...liveEnv, MODEL_BASE_URL: 'file:///tmp/model' } }), /HTTP/);
  assert.throws(() => createProvider({ env: { ...liveEnv, MODEL_TIMEOUT_MS: '0' } }), /integers/);
  const provider = createProvider({ env: liveEnv, fetchImpl: async () => completion('') });
  await assert.rejects(provider.complete({ system: 'system', prompt: 'user', model: 'general' }), /no text answer/);
});

test('model timeout terminates the run and does not fall back to fabricated output', async t => {
  const { engine } = await workspace(t, { env: { ...liveEnv, MODEL_TIMEOUT_MS: '100' }, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const created = await engine.createTask({ prompt: 'Summarize our rollout' });
  const result = await finished(engine, created.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /timed out/);
  assert.equal(result.answer, '');
});

test('storage budget rejects an oversized write before replacing the readable snapshot', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nexamiro-capacity-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = await createStore(dataDir, { maxBytes: 1024 });
  await store.save();
  store.state.documents.push({ text: 'x'.repeat(2000) });
  assert.throws(() => store.save(), { code: 'WORKSPACE_FULL', statusCode: 409 });
  store.state.documents.pop();
  store.state.documents.push({ text: 'x'.repeat(500) });
  assert.throws(() => store.save({ reserveBytes: 600 }), { code: 'WORKSPACE_FULL' });
  const reopened = await createStore(dataDir, { maxBytes: 1024 });
  assert.deepEqual(reopened.state.documents, []);
});

test('truncated and oversized provider answers fail explicitly instead of appearing complete', async () => {
  const truncated = createProvider({ env: liveEnv, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'An unfinished answer...' } }] })) });
  await assert.rejects(truncated.complete({ system: 'system', prompt: 'user', model: 'general' }), /token limit before finishing/);
  const oversized = createProvider({ env: liveEnv, fetchImpl: async () => completion('x'.repeat(20001)) });
  await assert.rejects(oversized.complete({ system: 'system', prompt: 'user', model: 'general' }), /exceeded the supported size/);
});

test('reasoning flag is validated and preserved for both completions and bounded probes', async () => {
  for (const setting of [undefined, 'true', 'false']) {
    const requests = [];
    const provider = createProvider({ env: { ...liveEnv, ...(setting === undefined ? {} : { MODEL_REASONING_ENABLED: setting }) }, fetchImpl: async (_url, options) => {
      requests.push(options);
      return completion('OK');
    } });
    await provider.complete({ system: 'system', prompt: 'user task', model: 'general-model' });
    const report = await provider.probe({ model: 'general-model' });
    assert.deepEqual(report, { usage: { inputTokens: 12, outputTokens: 7 } });
    for (const request of requests) {
      const body = JSON.parse(request.body);
      assert.equal(request.redirect, 'error');
      if (setting === undefined) assert.equal(Object.hasOwn(body, 'reasoning'), false);
      else assert.deepEqual(body.reasoning, { enabled: setting === 'true' });
    }
    const probeBody = JSON.parse(requests[1].body);
    assert.equal(probeBody.max_tokens, 128);
    assert.equal(probeBody.messages[1].content, 'Reply with OK');
    assert.equal(provider.info.reasoningEnabled, setting === undefined ? null : setting === 'true');
  }
  assert.throws(() => createProvider({ env: { ...liveEnv, MODEL_REASONING_ENABLED: 'yes' } }), /must be true, false, or unset/);
});

test('connection tests deduplicate models, use no workspace content, and keep reports in memory only', async t => {
  const requests = [];
  const { engine, dataDir } = await workspace(t, {
    env: { ...liveEnv, MODEL_CODING: liveEnv.MODEL_GENERAL, MODEL_REASONING_ENABLED: 'false' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return body.model === 'reasoning-model'
        ? new Response('Internal error test-secret-never-echo', { status: 403 })
        : completion('Provider output must stay private');
    },
  });
  await engine.addDocument({ name: 'Private.txt', text: 'SENSITIVE-WORKSPACE-DOCUMENT-CONTENT' });
  const snapshot = await readFile(join(dataDir, 'workspace.json'), 'utf8');
  assert.equal(engine.status().provider.connection, null);
  assert.equal(requests.length, 0);
  const report = await engine.testModels();
  assert.equal(report.ok, false);
  assert.equal(report.results.length, 2);
  assert.deepEqual(report.results[0].roles, ['general', 'coding']);
  assert.deepEqual(report.results[1].roles, ['reasoning']);
  assert.equal(report.results[0].ok, true);
  assert.equal(report.results[1].ok, false);
  assert.match(report.results[1].error, /HTTP 403/);
  assert.ok(report.results.every(result => Number.isInteger(result.latencyMs) && result.latencyMs >= 0));
  assert.doesNotMatch(JSON.stringify(report), /test-secret|Internal error|Provider output|SENSITIVE/);
  assert.doesNotMatch(JSON.stringify(requests), /SENSITIVE-WORKSPACE/);
  assert.deepEqual(engine.listTasks(), []);
  assert.equal(await readFile(join(dataDir, 'workspace.json'), 'utf8'), snapshot);
  assert.deepEqual(engine.status().provider.connection, report);
  report.results[0].ok = false;
  assert.equal(engine.status().provider.connection.results[0].ok, true);
});

test('connection test singleflight and completion cooldown prevent repeated model requests', async t => {
  let currentTime = Date.parse('2026-11-17T12:00:00Z');
  let calls = 0;
  const resolveResponses = [];
  const { engine } = await workspace(t, {
    env: { MODEL_BASE_URL: liveEnv.MODEL_BASE_URL, MODEL_GENERAL: 'shared-model' },
    clock: () => currentTime,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Promise(resolve => resolveResponses.push(resolve));
      return completion('OK');
    },
  });
  const pending = engine.testModels();
  await assert.rejects(engine.testModels(), { statusCode: 429 });
  assert.equal(calls, 1);
  resolveResponses[0](completion('OK'));
  const first = await pending;
  assert.equal(first.checkedAt, '2026-11-17T12:00:00.000Z');
  await assert.rejects(engine.testModels(), { statusCode: 429 });
  currentTime += 9999;
  await assert.rejects(engine.testModels(), { statusCode: 429 });
  currentTime++;
  assert.equal((await engine.testModels()).ok, true);
  assert.equal(calls, 2);
});

test('demo mode never probes and live probe timeouts return safe failures', async t => {
  const { engine: demo } = await workspace(t, { fetchImpl: () => { throw new Error('Unexpected fetch'); } });
  await assert.rejects(demo.testModels(), { statusCode: 400 });
  assert.equal(demo.status().provider.connection, null);
  const { engine: live } = await workspace(t, {
    env: { MODEL_BASE_URL: liveEnv.MODEL_BASE_URL, MODEL_GENERAL: 'shared-model', MODEL_TIMEOUT_MS: '100' },
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('SECRET network dump')), { once: true });
    }),
  });
  // Keep the test event loop alive while AbortSignal.timeout's unref timer fires.
  const hold = setInterval(() => {}, 1000);
  t.after(() => clearInterval(hold));
  const report = await live.testModels();
  assert.equal(report.ok, false);
  assert.match(report.results[0].error, /timed out/);
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test('probe enforces the 15-second maximum and response size without exposing rejected bodies', async t => {
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    timeouts.push(milliseconds);
    return originalTimeout.call(AbortSignal, milliseconds);
  });
  const provider = createProvider({ env: { ...liveEnv, MODEL_TIMEOUT_MS: '180000' }, fetchImpl: async () => completion('OK') });
  await provider.probe({ model: 'general-model' });
  assert.deepEqual(timeouts, [15000]);
  const oversized = createProvider({ env: liveEnv, fetchImpl: async () => new Response('SENSITIVE'.repeat(10000)) });
  await assert.rejects(oversized.probe({ model: 'general-model' }), error => /exceeded the supported size/.test(error.message) && !/SENSITIVE/.test(error.message));
  const truncated = createProvider({ env: { ...liveEnv, MODEL_REASONING_ENABLED: 'true', MODEL_MAX_TOKENS: '8192' }, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 128);
    assert.deepEqual(body.reasoning, { enabled: true });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'incomplete' } }] }));
  } });
  await assert.rejects(truncated.probe({ model: 'general-model' }), error => /connection test token limit/.test(error.message) && !/increase MODEL_MAX_TOKENS/.test(error.message));
  const redirect = createProvider({ env: liveEnv, fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    throw new TypeError('Redirect blocked with test-secret-never-echo');
  } });
  await assert.rejects(redirect.probe({ model: 'general-model' }), error => /Cannot reach/.test(error.message) && !/test-secret/.test(error.message));
});
