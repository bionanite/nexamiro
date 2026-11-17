# Nexamiro

A self-hosted workspace for AI-assisted work: give a task to a planner, a reasoning or coding specialist, and a reviewer; inspect the stages and save the result alongside your private knowledge.

This repository contains a working **single-workspace MVP**. It does not yet implement the complete infrastructure architecture: see [architecture and roadmap](docs/architecture.md).

## Run locally

Use Node.js 24 LTS (minimum 22.12).

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. The development command starts the API on port 8080 and the React/Vite frontend on port 3000. Both bind to loopback by default. If either port is occupied, stop the conflicting service first.

No credentials are required for the default **demo mode**. It simulates the three agent stages and performs real local document search; it does **not** generate a model answer or execute external actions. The interface and saved runs explicitly identify demo results.

For a production build served by the API:

```sh
npm run build
npm start
```

Then open **http://127.0.0.1:8080**. Copy `.env.example` to `.env` to configure your local server. Do not commit `.env`, credentials, or the `data/` directory.

## What works

- Responsive React workspace, run composer, history/search, detailed agent timeline, cancellation, rerun, answer copying, and Markdown export.
- Three bounded model calls per live run: planner → reasoning/coding specialist → reviewer. Auto routing chooses a specialist using task keywords; it is a deterministic heuristic.
- An OpenAI-compatible chat-completions endpoint, with separately configurable reasoning and coding model names. Endpoint errors do not silently produce demo answers.
- Text/Markdown document import or pasted text, chunking, local lexical retrieval, source excerpts, and deletion. Selected context is sent only when a live run uses it.
- Persistent run/document records, an atomic single-process store, a two-run worker pool, and a bounded queue. Interrupted runs become failed and can be retried as new runs.
- A read-only MCP stdio server exposes knowledge search, document listing, and run inspection to external MCP clients.
- Access-token authentication for non-loopback hosting, HttpOnly sessions, same-origin request controls, bounded input/model responses, Docker configuration, and CI tests/build.

## Connect a live model

For a guided Together AI setup, run this in an interactive terminal in the project folder:

```sh
npm run setup:model
```

Create your key in [Together's API keys settings](https://api.together.ai/settings/projects/~current/api-keys), then paste it at the hidden terminal prompt. The helper saves the key in the ignored local `.env` file with owner-only permissions; it never prints the key or makes a provider request. It preserves unrelated environment settings and sets all three agent roles to `Qwen/Qwen3.5-9B` with thinking disabled for the first test. Running setup again replaces those model settings. Do not paste your key into chat or commit it to GitHub.

Restart the server, then open **Models & tools → Test model connection**. The test makes one small billable request per distinct configured model, capped at 128 output tokens and 15 seconds per model. It sends only a synthetic prompt, not your documents or run history. Results show per-model success, latency, reported token use and safe error messages. A successful check verifies a text response; it does not evaluate answer quality or guarantee future availability. No checks run automatically.

For Ollama, vLLM or another compatible provider, configure the server manually:

Configure the server's `.env`:

```dotenv
MODEL_BASE_URL=http://127.0.0.1:11434/v1
MODEL_GENERAL=your-installed-model
# Optional for endpoints that require credentials:
MODEL_API_KEY=
# Optional specialist overrides; otherwise MODEL_GENERAL is used:
MODEL_REASONING=your-installed-reasoning-model
MODEL_CODING=your-installed-coding-model
MODEL_TIMEOUT_MS=60000
MODEL_MAX_TOKENS=1800
# Optional: only for providers/models supporting reasoning.enabled:
# MODEL_REASONING_ENABLED=false
```

Both `MODEL_BASE_URL` and `MODEL_GENERAL` are required to enable live mode. Replace the model placeholders with identifiers actually served by your endpoint, then restart Nexamiro. Configuration and connection-test results are shown separately; the latest test result resets after restarting. Live runs still surface endpoint/model errors. Local Ollama's compatible API is documented [here](https://docs.ollama.com/api/openai-compatibility); any provider used must support text `POST /chat/completions` under the supplied base URL. Together's [OpenAI compatibility](https://docs.together.ai/docs/inference/openai-compatibility) and [reasoning controls](https://docs.together.ai/docs/inference/chat/reasoning) describe its API contract.

Nexamiro does not install or download models. A live task may make three paid provider calls. Prompt, selected document excerpts, and previous agent outputs are transmitted to your configured provider. Local storage alone does not imply that inference stays on your machine. No external actions, shell execution, email sending, or web browsing are available to these agents.

## Docker

```sh
# Generate a token and put it in your untracked .env as ACCESS_TOKEN=...
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
docker compose up --build
```

Open http://127.0.0.1:3000 and enter that access token. Compose publishes only on loopback; the application binds within the container and requires the token. Data persists in the `nexamiro_data` volume. The container runs as a non-root user.

For a model running on your host, a container's `127.0.0.1` refers to the container. Use an address reachable from it (for example Docker Desktop's `host.docker.internal`) and configure your model service appropriately. Do not publish a model service without access controls.

For remote hosting, terminate HTTPS at your reverse proxy, set `COOKIE_SECURE=true`, and retain a strong `ACCESS_TOKEN`. Set `HOST=0.0.0.0` only with a token of at least 24 characters. This is one trusted workspace with a shared token, not tenant isolation or enterprise SSO. All authenticated workspace users can read its documents and runs.

## MCP

Start the API first. Then an MCP client can launch:

```json
{
  "mcpServers": {
    "nexamiro": {
      "command": "node",
      "args": ["/absolute/path/to/nexamiro/backend/mcp-server.js"],
      "env": {
        "NEXAMIRO_API_URL": "http://127.0.0.1:8080",
        "ACCESS_TOKEN": "your-workspace-token-if-configured"
      }
    }
  }
}
```

Tools: `query_enterprise_knowledge`, `list_agent_runs`, `get_agent_run`, and `list_knowledge_documents`. They read the running gateway; the MCP process never opens a second writer against the data store. The knowledge tool uses lexical retrieval, not a vector database. Optional `MCP_API_TIMEOUT_MS` bounds API requests. `npm run mcp` starts the same stdio server with local `.env` loading.

## Validation and API

```sh
npm test
npm run build
```

Tests exercise actual orchestration, retrieval, restart handling, cancellation, provider limits, the HTTP request handler, token/cookie access, origin restrictions, and MCP SDK transports. Model-provider calls are mocked; the default test suite needs neither paid keys nor a listening network socket. CI repeats tests and the production build.

See [API reference](docs/api.md) for routes. `GET /api/health` is a minimal unauthenticated health check.

## Data and limits

`NEXAMIRO_DATA_DIR` defaults to `./data` at the repository root. Back up `workspace.json` while the server is stopped. Use **one API process per data directory**; this JSON store is not a multi-process database. Documents and completed run excerpts are stored in plaintext with restrictive file permissions. Removing a document does not erase excerpts already retained in run history.

Current limits are 500 runs, 100 documents, 200,000 characters per document, 16,000 characters per prompt, two concurrent runs, and 20 queued/running tasks. The persisted store is capped at 64 MiB, with capacity reserved for active runs; large records can reach that budget before the count limits. Start a new data directory after archiving a full workspace. A restart does not replay incomplete runs automatically; rerun explicitly to avoid unplanned provider costs.

## Current boundaries

Knowledge retrieval is local lexical search with bounded context excerpts, not semantic vector RAG or guaranteed whole-document summarization. Agent execution is sequential and text-only. GPU provisioning, self-hosted inference deployment, fine-tuning, external action approval workflows, vector database adapters, tenant isolation, and compliance certifications are future work. An architecture diagram or a container does not confer GDPR, HIPAA, or SOC 2 compliance.
