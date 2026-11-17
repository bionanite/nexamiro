import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../backend/mcp-server.js';

const MCP_PATH = fileURLToPath(new URL('../backend/mcp-server.js', import.meta.url));
const TOKEN = 'test-token-for-mcp-only';

function decode(response) {
  return JSON.parse(response.content.find(item => item.type === 'text').text);
}

async function memoryClient(t, options = {}) {
  const server = createMcpServer(options);
  const client = new Client({ name: 'nexamiro-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('stdio MCP process handshakes and advertises four read-only tools', async t => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_PATH],
    env: { NEXAMIRO_API_URL: 'http://127.0.0.1:8080', ACCESS_TOKEN: TOKEN },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-smoke-test', version: '1.0.0' });
  t.after(async () => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'get_agent_run', 'list_agent_runs', 'list_knowledge_documents', 'query_enterprise_knowledge',
  ]);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
});

test('SDK client calls all four tools and forwards the correct authenticated API requests', async t => {
  const requests = [];
  const client = await memoryClient(t, {
    env: { ACCESS_TOKEN: TOKEN },
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      requests.push({ path, method: options.method, auth: options.headers.authorization, body: options.body });
      if (options.headers.authorization !== `Bearer ${TOKEN}`) return Response.json({ error: 'Not authorized' }, { status: 401 });
      const task = { id: 'run-1', title: 'A persisted run', status: 'completed', mode: 'auto', answer: 'Verified result' };
      if (path === '/api/tasks') return Response.json({ tasks: [task] });
      if (path === '/api/tasks/run-1') return Response.json({ task });
      if (path === '/api/documents') return Response.json({ documents: [{ id: 'doc-1', name: 'Handbook.md', characters: 17, chunkCount: 1 }] });
      if (path === '/api/knowledge/search') return Response.json({ results: [
        { documentId: 'doc-1', name: 'Handbook.md', excerpt: 'Approved policy', score: 2 },
        { documentId: 'doc-2', name: 'Notes.md', excerpt: 'Another policy', score: 1 },
      ] });
      return Response.json({}, { status: 404 });
    },
  });
  const list = decode(await client.callTool({ name: 'list_agent_runs', arguments: {} }));
  assert.equal(list.tasks[0].id, 'run-1');
  assert.equal(list.tasks[0].answer, undefined, 'lists return summaries, not full conversation contents');
  assert.equal(list.total, 1);
  const run = decode(await client.callTool({ name: 'get_agent_run', arguments: { task_id: 'run-1' } }));
  assert.equal(run.task.answer, 'Verified result');
  const docs = decode(await client.callTool({ name: 'list_knowledge_documents', arguments: {} }));
  assert.equal(docs.documents[0].name, 'Handbook.md');
  const search = decode(await client.callTool({ name: 'query_enterprise_knowledge', arguments: { query: 'policy', top_k: 1 } }));
  assert.equal(search.retrieval, 'lexical');
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].excerpt, 'Approved policy');
  assert.ok(requests.every(request => request.auth === `Bearer ${TOKEN}`));
  assert.deepEqual(requests.map(request => [request.method, request.path]), [
    ['GET', '/api/tasks'], ['GET', '/api/tasks/run-1'], ['GET', '/api/documents'], ['POST', '/api/knowledge/search'],
  ]);
  assert.deepEqual(JSON.parse(requests[3].body), { query: 'policy' });
});

test('MCP rejects traversal IDs and out-of-range search limits before an API request', async t => {
  let calls = 0;
  const client = await memoryClient(t, { env: {}, fetchImpl: async () => { calls++; return Response.json({}); } });
  for (const request of [
    { name: 'get_agent_run', arguments: { task_id: '../documents' } },
    { name: 'query_enterprise_knowledge', arguments: { query: 'policy', top_k: 11 } },
    { name: 'query_enterprise_knowledge', arguments: { query: ' ', top_k: 1 } },
  ]) {
    const response = await client.callTool(request);
    assert.equal(response.isError, true);
  }
  assert.equal(calls, 0);
});

test('API errors are structured and do not expose raw response bodies or credentials', async t => {
  const client = await memoryClient(t, {
    env: { ACCESS_TOKEN: TOKEN },
    fetchImpl: async () => new Response(`internal details ${TOKEN}`, { status: 401 }),
  });
  const response = await client.callTool({ name: 'list_agent_runs', arguments: {} });
  assert.equal(response.isError, true);
  assert.equal(decode(response).error.code, 'AUTH_REQUIRED');
  assert.ok(!JSON.stringify(response).includes(TOKEN));
  assert.ok(!JSON.stringify(response).includes('internal details'));
});

test('network errors remain safe and missing records are reported distinctly', async t => {
  let missing = false;
  const client = await memoryClient(t, {
    env: {},
    fetchImpl: async () => {
      if (missing) return new Response('private infrastructure path', { status: 404 });
      throw new Error('private-internal-hostname-and-key');
    },
  });
  let response = await client.callTool({ name: 'get_agent_run', arguments: { task_id: 'run-1' } });
  assert.equal(decode(response).error.code, 'API_UNAVAILABLE');
  assert.ok(!JSON.stringify(response).includes('private-internal'));
  missing = true;
  response = await client.callTool({ name: 'get_agent_run', arguments: { task_id: 'run-1' } });
  assert.equal(decode(response).error.code, 'NOT_FOUND');
});

test('MCP rejects malformed and oversized gateway responses', async t => {
  let response = new Response('not JSON');
  const client = await memoryClient(t, { env: {}, fetchImpl: async () => response });
  let actual = await client.callTool({ name: 'list_knowledge_documents', arguments: {} });
  assert.equal(decode(actual).error.code, 'BAD_RESPONSE');
  response = new Response('x'.repeat(2 * 1024 * 1024 + 1));
  actual = await client.callTool({ name: 'list_knowledge_documents', arguments: {} });
  assert.equal(decode(actual).error.code, 'RESPONSE_TOO_LARGE');
  response = Response.json({ wrong: [] });
  actual = await client.callTool({ name: 'list_knowledge_documents', arguments: {} });
  assert.equal(decode(actual).error.code, 'BAD_RESPONSE');
});

test('MCP times out stalled API requests', async t => {
  // Keep the event loop alive while the unref'ed AbortSignal timeout fires.
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  const client = await memoryClient(t, {
    env: { MCP_API_TIMEOUT_MS: '100' },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  const response = await client.callTool({ name: 'list_knowledge_documents', arguments: {} });
  assert.equal(response.isError, true);
  assert.equal(decode(response).error.code, 'TIMEOUT');
});

test('MCP configuration rejects URLs with embedded credentials', () => {
  assert.throws(() => createMcpServer({ env: { NEXAMIRO_API_URL: 'https://user:secret@example.test' } }),
    /without credentials/);
});
