# HTTP API

All routes are same-origin `/api/...`. Except health and sign-in, configured workspaces require `Authorization: Bearer <ACCESS_TOKEN>` or an HttpOnly session cookie from sign-in. JSON request bodies use `Content-Type: application/json`. Errors use `{ "error": "message" }` with appropriate HTTP status codes.

| Method | Route | Request | Result |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ok:true}` |
| POST | `/api/session` | `{token}` | `{ok:true}` and session cookie |
| DELETE | `/api/session` | — | Clears current cookie session |
| GET | `/api/status` | — | Mode, configured provider/model mapping, supported tools, document count |
| POST | `/api/models/test` | `{}` only | `{ok,checkedAt,results:[{model,roles,ok,latencyMs,usage?,error?}]}` |
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

Model connection tests require the same authentication and origin checks as other protected APIs. They accept an empty JSON object only; the server chooses every endpoint, model and prompt from its configuration. Each distinct configured model receives one synthetic completion request (up to 128 output tokens, at most 15 seconds). Tests preserve the configured reasoning setting, never send documents or task history, and do not create runs. A probe error is reported safely in the HTTP 200 report; demo mode returns 400, and simultaneous tests or requests within the 10-second cooldown return 429. The last finished report is available as `provider.connection` in status, or `null` when untested since startup. Test success verifies a nonempty text response, not output quality. `provider.reasoningEnabled` is `true`, `false`, or `null` (provider default).

An empty `documentIds` on a task means no knowledge context. Standalone knowledge search without a document filter searches all workspace documents. Explicitly selected context is bounded; responses do not imply exhaustive document coverage.

Sign-in is rate limited to ten attempts per minute per socket peer. Sessions expire after twelve hours or a server restart. For HTTPS remote deployments, set `COOKIE_SECURE=true`. A token holder can access all data in the workspace.
