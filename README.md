# Eval infra: LiteLLM + Langfuse + Ollama

Local dev stack giving model access (local + cloud) with routing/fallbacks,
per-consumer credentials, and full tracing.

- **LiteLLM proxy** — model access, routing, fallbacks, credentials, quotas,
  provider abstraction over Ollama and cloud providers.
- **Langfuse (self-hosted)** — traces, debugging, evals, cost/quality
  analysis. Wired up automatically via LiteLLM's built-in callback.
- **Ollama** — serves local models. Runs natively on the host (not in
  Docker), so it keeps GPU/Metal access.
- **plugin-backend** — a minimal Fastify app that exists *only* because the
  Blockly plugin has no backend of its own and can't safely hold a LiteLLM
  key. It authenticates plugin requests with a static key and forwards to
  LiteLLM using a virtual key held server-side. Pure passthrough, nothing
  more.

The **dashboard is not routed through anything here** — it has its own
backend, so it gets its own LiteLLM virtual key and calls LiteLLM directly.

## Prerequisites

- Docker + Docker Compose
- [Ollama](https://ollama.com) installed and running on the host
  (`ollama pull llama3.1`, or swap the model in `litellm/config.yaml`)

## Setup

```bash
cp .env.example .env
```

Fill in `.env`:
- Generate every blank secret with `openssl rand -hex 32` (or `-hex 16` for
  shorter ones like `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`/`SECRET_KEY` — keep
  the `pk-lf-`/`sk-lf-` prefixes).
- Reuse the same value for `MINIO_ROOT_PASSWORD` and the three
  `LANGFUSE_S3_*_SECRET_ACCESS_KEY` vars.
- Add `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` for whichever cloud providers
  you want reachable (leave others blank).
- Pick any string for `PLUGIN_API_KEYS` (comma-separated if more than one
  install) — this is the key the Blockly plugin itself will send.
- Leave `PLUGIN_LITELLM_VIRTUAL_KEY` blank for now — see step 3 below.

## Bootstrap

LiteLLM's virtual keys don't exist until the proxy has started once, so bring
the stack up in two passes:

1. **Start Langfuse + LiteLLM:**

   ```bash
   docker compose up -d
   ```

   Langfuse auto-provisions the org/project/user and fixed API keys from the
   `LANGFUSE_INIT_*` vars in `.env` on first boot — no manual UI step needed.
   `plugin-backend` will fail to start yet (no virtual key set) — that's
   expected, continue to step 2.

2. **Mint the two LiteLLM virtual keys**, authenticating with
   `LITELLM_MASTER_KEY`:

   ```bash
   # For the dashboard's own backend - hand this key off to it, don't store
   # it in this repo.
   curl -s http://localhost:4000/key/generate \
     -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
     -H "Content-Type: application/json" \
     -d '{"key_alias": "dashboard"}'

   # For the Blockly plugin backend - this one goes in .env below.
   curl -s http://localhost:4000/key/generate \
     -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
     -H "Content-Type: application/json" \
     -d '{"key_alias": "blockly-plugin"}'
   ```

   Add `"models": ["..."]` / `"max_budget": ...` to either call if you want
   the plugin capped differently from the dashboard.

3. Put the `blockly-plugin` key's `key` field into `.env` as
   `PLUGIN_LITELLM_VIRTUAL_KEY`, then:

   ```bash
   docker compose up -d plugin-backend
   ```

## Verify end-to-end

```bash
# Dashboard path: straight to LiteLLM with the dashboard's own virtual key
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <dashboard virtual key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "local-llama3.1", "messages": [{"role": "user", "content": "hi"}]}'

curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <dashboard virtual key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]}'

# Blockly plugin path: through plugin-backend, plugin never sees a LiteLLM key
curl http://localhost:5000/v1/chat/completions \
  -H "Authorization: Bearer <one of PLUGIN_API_KEYS>" \
  -H "Content-Type: application/json" \
  -d '{"model": "local-llama3.1", "messages": [{"role": "user", "content": "hi"}]}'

# Bad/missing plugin key should be rejected before ever reaching LiteLLM
curl -i http://localhost:5000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "local-llama3.1", "messages": [{"role": "user", "content": "hi"}]}'
```

Then open `http://localhost:3000` (Langfuse UI) and confirm all the above
requests show up as traces, distinguishable by which virtual key made the
call.

To sanity-check the configured fallback (`gpt-4o-mini` → `local-llama3.1` in
`litellm/config.yaml`), temporarily set `OPENAI_API_KEY` to something invalid,
restart `litellm`, and re-run the `gpt-4o-mini` request above — it should
still succeed via the local model, and the trace in Langfuse should show the
fallback.

## Adding vLLM or another local model

Add another entry to `model_list` in `litellm/config.yaml` pointing at its
OpenAI-compatible endpoint (same pattern as the Ollama entry) — no other
changes needed.
