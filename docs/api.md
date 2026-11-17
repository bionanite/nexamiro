# HTTP API

All routes are same-origin `/api/...`. Except health and sign-in, configured workspaces require `Authorization: Bearer <ACCESS_TOKEN>` or an HttpOnly session cookie from sign-in. JSON request bodies use `Content-Type: application/json`. Errors use `{ "error": "message" }` with appropriate HTTP status codes.

| Method | Route | Request | Result |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ok:true}` |
| POST | `/api/session` | `{token}` | `{ok:true}` and session cookie |
| DELETE | `/api/session` | — | Clears current cookie session |
| GET | `/api/status` | — | Mode, configured provider/model mapping, supported tools, document count |
| GET | `/api/tasks` | — | `{tasks:[]}`, newest first |
| POST | `/api/tasks` | `{prompt,mode,documentIds}` | HTTP 202 `{task}` |
| GET | `/api/tasks/:id` | — | `{task}` |
| POST | `/api/tasks/:id/cancel` | `{}` | `{task}`; completed runs are unchanged |
| POST | `/api/tasks/:id/retry` | `{}` | HTTP 202 `{task}` with a new ID |
| GET | `/api/documents` | — | `{documents:[]}` metadata |
| POST | `/api/documents` | `{name,text}` | HTTP 201 `{document}` metadata |
| DELETE | `/api/documents/:id` | — | `{ok:true}`; active run use returns 409 |
| POST | `/api/knowledge/search` | `{query,documentIds?}` | `{results:[]}` bounded lexical matches |

Task modes: `auto`, `reasoning`, `coding`. Statuses: `queued`, `running`, `completed`, `failed`, `cancelled`. A task retains `executionMode` (`demo` or `live`) independently of the current server configuration. The `model` field names the specialist model; planning uses the general model and review uses the reasoning model. Usage is accumulated from provider-reported tokens and is not a billing statement.

An empty `documentIds` on a task means no knowledge context. Standalone knowledge search without a document filter searches all workspace documents. Explicitly selected context is bounded; responses do not imply exhaustive document coverage.

Sign-in is rate limited to ten attempts per minute per socket peer. Sessions expire after twelve hours or a server restart. For HTTPS remote deployments, set `COOKIE_SECURE=true`. A token holder can access all data in the workspace.
