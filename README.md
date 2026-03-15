# The Council — Multi-Agent AI Debate Arena (Notion MCP)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?logo=opensourceinitiative)](./LICENSE)

A Multi-Agent debate system that runs inside Notion using the Model Context Protocol (MCP).
Four agents with distinct personas debate a technical question on a Notion page; an arbiter then writes a final decision, reasoning, and action items back to the page. Everything is done via MCP tools—no direct REST calls to Notion.

---

## Quick summary

- Input: a Notion database page with the `Question` title and `Status: pending`.
- Process: watcher detects pending pages → opens MCP connection → runs 3 rounds (based on your choice) of parallel agent debates → arbiter writes decision.
- Output: Notion page updated with debate callouts, `Decision` rich text, `Status` set to `completed`

Agents: ⚔️ SENTINEL (security), ⚡ MERCURY (performance), 💰 MIDAS (cost), 🌍 ATLAS (scale).

---

## What you'll find in this repo

- `api/` — Express server and SSE endpoints for streaming debates to the dashboard.
- `src/core/mcpClient.js` — MCP wrapper: adaptive query probing, schema-aware property formatting, safe wrappers.
- `src/agents/` — agent implementations and shared `baseAgent` logic.
- `src/core/orchestrator.js` — debate state machine and arbiter logic.
- `src/watcher/` — polls the Notion DB for `pending` pages and spawns debates.
- `public/` — tiny frontend dashboard that consumes SSE and shows live agent output.

---

## Notion database setup

Create a database with these properties (exact types):

- `Question` — Title
- `Status` — Select (values used by the app: `pending`, `assembling`, `debating`, `consensus`, `deadlocked`, `completed`)
- `Vote` — Select (values: `SENTINEL`, `MERCURY`, `MIDAS`, `ATLAS`)
- `Decision` — Text
- `Debate` — Text

---

## Environment variables (fill `.env`)

The repo ships with a `.env.example` — copy that to `.env` and fill in your keys. Important variables:

- `NOTION_API_KEY` — Notion integration/MCP token
- `NOTION_DATABASE_ID` — target database id
- `GEMINI_API_KEY` — primary LLM key (Gemini)
- `GROQ_API_KEY` — fallback LLM key (Groq/Responses)
- `POLL_INTERVAL_SECONDS` — watcher poll interval (default: 10)

Make sure your Notion integration has permission to the database and pages you want to use.

---

## Local development

```powershell
git clone https://github.com/thecoderadi/the-council
cd the-council
npm install
copy .env.example .env
# edit .env to add your keys
npm run dev
# Open http://localhost:3000 in your browser
```

If you're on macOS/Linux use `cp .env.example .env`.

---

## How the MCP interaction works (short)

- The watcher calls the MCP tool `API-query-data-source` to locate `Status: pending` rows. Because MCP adapters differ, the client probes candidate arg shapes and caches the working shape.
- Agents use `API-get-block-children`, `API-patch-block-children` to read and append blocks. After appending, agents update the page `Debate` property (rich_text) so the DB row shows the debate text in table view.
- The arbiter uses an LLM call to synthesize the final `Decision` and writes `Action Items` as checkbox blocks.

---

## API reference (short)

The project exposes a small HTTP API used by the frontend and for integrations. Key endpoints:

- GET /debate/validate?page_id=<id>&question=<q>[&rounds=<n>]
  - Purpose: quick server-side validation that the MCP bridge can access the provided Notion page. Returns 200 OK with { ok: true } on success or 400/500 on failure.
  - Notes: `rounds` is accepted but only used client-side for consistency with the stream flow — validation focuses on page access.

- GET /debate/stream?page_id=<id>&question=<q>&rounds=<n>
  - Purpose: opens a Server-Sent Events (SSE) stream for a live debate. The server validates page access then streams events as the debate runs.
  - Important query params:
    - `page_id` (required) — Notion page ID or full Notion URL (the server normalizes it).
    - `question` (required) — The debate question text.
    - `rounds` (optional) — Number of debate rounds to run. If omitted, server uses `DEBATE_MAX_ROUNDS` env or defaults to 3.
  - Events emitted: `connected`, `status`, `round_start`, `argument`, `consensus`, `deadlock`, `complete`, `error`.

- POST /debate/trigger
  - Purpose: trigger a background debate without keeping an SSE connection open.
  - Body (JSON): { page_id, question, rounds? }

- POST /debate/vote
  - Purpose: cast a vote to resolve a deadlocked debate. Body: { page_id, chosen_agent, user_reasoning? }

- GET /debates
  - Purpose: list simplified debates from the configured Notion database (for tooling/debug UIs).

- GET /debates/active
  - Purpose: list active in-memory debates being streamed/processed by this server instance.

Examples:

Validate a page:

```bash
curl "http://localhost:3000/debate/validate?page_id=<PAGE_ID>&question=$(uri_encode "Should we...?")"
```

Start a stream (browser frontend uses EventSource):

```
# Frontend opens an EventSource to the /debate/stream URL. Use the UI to start a stream.
```

Trigger a background debate:

```bash
curl -X POST http://localhost:3000/debate/trigger \
  -H 'Content-Type: application/json' \
  -d '{"page_id":"<PAGE_ID>","question":"Should we...","rounds":3}'
```

---

## Rounds parameter

The new `rounds` parameter controls how many debate rounds the system runs.

- Frontend: clamps user input to `1..10` and sends `rounds` to the validation and stream endpoints.
- Server: parses `rounds` and clamps/validates it; invalid or missing values fall back to `DEBATE_MAX_ROUNDS` env or 3. Server-side cap is generous (50) to avoid accidental runaway loops; changeable in `api/server.js`.
- Orchestrator: reads the `rounds` value passed from the server and runs that many rounds. If no value is provided it uses `DEBATE_MAX_ROUNDS` or defaults to 3.
- Watcher: background watcher currently uses the env/default behavior (it does not pass per-page rounds). If you want per-page round configuration you can add a `Rounds` property to your Notion DB and wire the watcher to read that property.

Recommendation: default to 3 rounds for most debates (good balance between depth and cost). Use 1 for quick checks and 5+ for deep analyses — remember LLM token costs scale with rounds.

---

## Implemented features (what's in the repo right now)

This project includes a set of production-minded features implemented across the server, orchestrator, agents, MCP client and frontend. Each bullet lists the feature and the file(s) you can inspect for the implementation.

- LLM provider fallback (Gemini → Groq on 429)
  - Implemented in `src/core/llmClient.js` — the `generate()` facade detects Gemini quota/429 errors and automatically attempts Groq when GROQ credentials are present.

- LLM concurrency control and minimum delay
  - `src/core/llmClient.js` implements a simple semaphore and MIN_DELAY_MS to limit concurrent LLM calls and space out requests.

- Deterministic agent fallback when LLMs fail
  - `src/agents/baseAgent.js` uses a role-based deterministic fallback argument when LLM calls fail so debates continue even under quota.

- Orchestrator-level LLM provider visibility
  - `src/core/orchestrator.js` captures the arbiter LLM provider used and emits it in the consensus event so the UI and logs can see if a fallback occurred.

- Rounds configurable from the UI or API
  - Frontend: `public/index.html` adds a `rounds` input and passes it to `GET /debate/stream` and `/debate/validate`.
  - Server: `api/server.js` reads `rounds` and passes it to `CouncilOrchestrator.runDebateStream(pageId, question, rounds)`.
  - Orchestrator: `src/core/orchestrator.js` accepts `rounds` and runs that many rounds (falls back to env/default if not provided).

- Adaptive MCP query probing and safe calls
  - `src/core/mcpClient.js` probes candidate argument shapes for `API-query-data-source`, caches a working shape, and falls back to `API-post-search` when necessary. It also implements per-tool quiet windows to suppress repeated 400 logs.

- Schema-aware Notion writes
  - `src/core/mcpClient.js` exposes `formatPropertiesForDatabase()` and `updatePageFormatted()` to map simple key→value into Notion property shapes before calling `API-patch-page` or `API-post-page`.
  - `api/server.js`'s create endpoint uses the formatter so created pages appear correctly in DB views.

- Real-time Debate property updates
  - `src/agents/baseAgent.js` appends argument blocks and updates the page `Debate` property with the latest content so the database table shows the debate live.

- Watcher resilience and auto-complete
  - `src/watcher/notionWatcher.js` queries the database without sending fragile filters, filters locally, spawns background debates, and auto-completes deadlocked pages when a `Vote` select value is set.

- Frontend validation and friendly UX
  - `public/index.html` extracts Notion page ids from full URLs, calls `/debate/validate` before opening SSE, and provides clear error cards if MCP lacks access.

- SSE streaming API with rich events
  - `api/server.js` exposes `/debate/stream` which streams events (`connected`, `status`, `round_start`, `argument`, `consensus`, `deadlock`, `complete`, `error`) produced by `CouncilOrchestrator`.

- Safety: no attempt to set Notion system `created_time`
  - The create flow intentionally does not overwrite Notion's read-only `created_time` property; see `api/server.js`.

- Repo hygiene: removed embedded MCP token
  - `mcp_config.json` was sanitized and replaced with `mcp_config.example.json`. `.gitignore` updated to prevent committing local secrets.

## LLM strategy and operational notes

- Primary model: Gemini. Fallback: Groq. When Gemini returns 429 the `generate()` facade attempts Groq. If both rate-limit, agents fall back to deterministic short responses so the flow continues.
- Current limitations: the repo retries on 429 but does not yet implement a Retry-After-aware exponential backoff or a token-bucket limiter — these are in the roadmap.
- Cost: each debate runs 5 agents-ish (4 debaters + arbiter) and multiple prompt/response cycles — expect per-debate token cost. Instrument LLM usage before running at scale.

---

## Security & privacy

- The system writes user-provided content into your Notion workspace. Do not feed secrets or PII into prompts/pages you want to keep private unless you accept that data will be stored in Notion.
- Ensure your `NOTION_API_KEY` is kept private (use host secret stores for production).
- Grant the Notion integration the minimum scopes necessary to the target database.
- Log and monitor LLM errors and MCP tool failures to detect unusual access or quota exhaustion.

---

## Troubleshooting

- I see repeated `400 Bad Request` from `API-query-data-source`:
  - The client probes argument shapes (different field names) because MCP adapters accept different payload shapes. The client caches a working shape in memory. Persisting this cache across restarts is on the TODO list.

- Notion writes not appearing or `permission denied`:
  - Confirm integration is added to the workspace and has access to the database and the specific page. Use the repo's `GET /debate/validate` endpoint (the frontend calls this automatically when you paste a page URL) to validate access.

- Agents return short fallback responses when LLMs rate limit:
  - Check LLM logs and plan rate-limit backoff. The system will use Groq if Gemini responds 429.

---

## Contributing

Open issues or PRs welcome. For significant features, open an issue first to discuss the design. Small, focused PRs with tests are easiest to review.
