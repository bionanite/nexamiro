# Architecture and development roadmap

The supplied five-layer architecture is the product direction. This MVP implements a useful vertical slice while making unavailable capabilities explicit.

| Diagram layer | Implemented now | Next substantial work |
| --- | --- | --- |
| User interface and applications | React workspace, authenticated HTTP API, run history and knowledge views | User accounts, organization roles, streaming responses, SDK |
| Agent orchestration and tools | Persistent sequential planner/specialist/reviewer runs; cancellation and retry; read-only MCP tools | Durable queue/database workers, interruption checkpoints, approved external actions, sandboxed execution |
| Domain knowledge | Text/Markdown ingestion, chunking, lexical search, selected source excerpts | Embeddings, Qdrant adapter, source access controls, ingestion jobs, retrieval evaluation |
| Model serving | Configured OpenAI-compatible endpoint; per-role model mapping; timeout/output limits | Provider health/capacity selection, fallback rules, cost budgets, serving deployment |
| Infrastructure | One Node service, non-root Docker image, persistent volume, CI | PostgreSQL, secret manager, observability, SSO, multi-tenant isolation, infrastructure provisioning |

## Request flow

1. The browser sends a task and selected document IDs to the same-origin gateway.
2. The gateway validates access, content type, and input. The engine persists the queued run before accepting it.
3. One of two workers takes the run. The engine retrieves bounded excerpts from selected documents; arbitrary documents are not included implicitly.
4. Live mode calls planner, specialist, and reviewer models in order. The reviewer returns the final answer. A failure stops the run and is visible to the user.
5. Each stage, source excerpt, and reported token count is persisted. Cancellation aborts the current request. Restarted incomplete runs are marked failed and require an explicit new run.
6. The UI refreshes active runs. MCP clients can inspect the same state through read-only authenticated API calls.

Demo mode performs the workflow without a model call and preserves that provenance in each saved run. A subsequent configuration change must not relabel old demo runs as live.

## Deliberate constraints

- **No automatic tool execution:** the model never gets filesystem, terminal, email, or arbitrary HTTP tools. The MCP server is for clients to inspect Nexamiro; it is not an unconstrained tool gateway.
- **Fixed provider configuration:** endpoints and secrets come from server environment variables, not task input. Redirects are rejected. Credentials are excluded from status and sanitized errors.
- **Single workspace:** a shared access token gates access; it is not identity or authorization per document.
- **Single process:** the atomic JSON store is appropriate for local validation. Horizontal scaling requires a transactional store and worker coordination.
- **Bounded retrieval:** excerpts may not cover an entire document. The agent is instructed to acknowledge absent evidence and cite retrieved sources.

## Recommended next implementation sequence

1. Validate the core workflow with a chosen model and representative business tasks; record quality, latency, and token cost.
2. Move persistence and run leases to PostgreSQL, add durable checkpoints, and test worker crash/recovery.
3. Add identity, workspace membership, document ACLs, audit records, retention/export/deletion controls, and encryption appropriate to deployment.
4. Add an embedding provider plus Qdrant adapter and an evaluation dataset comparing retrieval to the lexical baseline.
5. Introduce external tools with typed inputs, per-tool permissions, approval before side effects, idempotency keys, budgets, and a sandbox.
6. Add model cost/latency routing and infrastructure appropriate to measured workload. Fine-tuning follows demonstrated evaluation gaps and suitable training rights/data.
