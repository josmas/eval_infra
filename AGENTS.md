# AGENTS.md

Instructions for AI agents (and future-you) working on `eval_infra`.

## What this is

A local LLM gateway stack: LiteLLM proxy (routing/fallbacks/credentials/quotas
over local models + cloud providers), self-hosted Langfuse (tracing/evals),
Ollama/LM Studio (local model serving), and `plugin-backend` (a minimal
Fastify app). See `README.md` for setup/usage.

## Architecture rule - don't undo this without discussion

The design is deliberately **asymmetric** across consumers:

- The **dashboard** has its own backend, so it calls LiteLLM **directly**
  with its own LiteLLM virtual key. It is not routed through anything in
  this repo.
- The **Blockly plugin** has no backend of its own and can't safely hold a
  LiteLLM key client-side, so `plugin-backend` (Fastify) exists solely to be
  its backend: check a static plugin API key, forward to LiteLLM using a
  virtual key held server-side. It is a **pure passthrough** by design - one
  route, no other logic.

If a new consumer needs to be added: does it already have a trusted backend
of its own? If yes, mint it a LiteLLM virtual key and point it at LiteLLM
directly - don't route it through `plugin-backend`. Only route a consumer
through `plugin-backend` (or a new equivalent) if it's client-side code with
nowhere else to hold a secret.

Do not collapse this back into "one generic proxy in front of LiteLLM for
everyone" - that was the original ask and was deliberately rejected because
LiteLLM's own proxy already provides routing/fallbacks/per-consumer virtual
keys/budgets, and a blanket proxy would just duplicate that.

## Known operational gotchas

1. **LiteLLM needs its own Postgres for `/key/generate`.** The `litellm-db`
   service (separate from Langfuse's own postgres) backs LiteLLM's virtual
   key/budget management. Without a `DATABASE_URL` pointed at it, `/key/generate`
   fails with "DB not connected".

2. **Editing `litellm/config.yaml` needs a manual restart.** It's bind-mounted;
   Compose only recreates a container when the container's own definition
   changes, not when a mounted file's contents do. Run
   `docker compose restart litellm` after any config change.

3. **Port 5000 conflicts with macOS's AirPlay Receiver/ControlCenter**, which
   binds `*:5000` system-wide and returns a blind 403 with zero trace in the
   app's own logs. `plugin-backend` is published on host port **5050**
   (still 5000 inside the container) specifically to dodge this. Don't put a
   new service on host port 5000 on macOS.

4. **Langfuse v4 needs `LANGFUSE_MIGRATION_V4_WRITE_MODE=dual`** (set on both
   `langfuse-web` and `langfuse-worker` - already in `docker-compose.yml`,
   defaulted to `dual`). Without it, v4's `events_only` mode silently drops
   everything sent via the legacy `/api/public/ingestion` endpoint, which is
   what LiteLLM's built-in `success_callback: ["langfuse"]` uses. Symptom: no
   traces show up, no error on the LiteLLM side, only a "Rejected N event(s)...
   events_only mode" warning in `langfuse-web`'s logs.

5. Compose's `:?required` var syntax blocks interpolation for the **entire**
   file, not just the service that uses it - a missing required var on one
   service prevents `docker compose up -d` from starting *anything*. That's
   why `LITELLM_MASTER_KEY`/`LITELLM_SALT_KEY`/`PLUGIN_LITELLM_VIRTUAL_KEY`/
   `PLUGIN_API_KEYS` all use soft `:-` defaults instead - each service
   validates itself at runtime and fails on its own (`plugin-backend`'s own
   code checks and logs a clear error) rather than blocking the whole stack.

6. If a model hangs/never responds when called through this stack, check
   whether it also hangs called **directly** (LM Studio's own UI, or a plain
   curl to its port, bypassing LiteLLM/Fastify entirely) before assuming
   anything here is broken - a bad chat template/EOS-token config on the
   model-serving side looks identical to a stuck request from this stack's
   point of view.

## Conventions

- The Langfuse service block in `docker-compose.yml` is pulled close to
  verbatim from the official `langfuse/langfuse` compose file (pinned tag
  noted at the top of the file) - keep it that way so it stays easy to diff
  against upstream when bumping versions. Put anything eval_infra-specific
  in the `litellm`/`litellm-db`/`plugin-backend` services instead.
- Everything in `.env` is local-dev-only placeholder values (see the
  comments at the top of `.env.example`) - fine because nothing here is
  exposed beyond `localhost`. Don't "harden" these without being asked;
  don't treat their simplicity as a bug.
