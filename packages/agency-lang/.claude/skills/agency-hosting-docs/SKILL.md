---
name: agency-hosting-docs
description: Developer docs for hosting Agency agents and the statelog integration: the observability event stream, the CLI's statelog clients, deploying and serving an agent over HTTP, per-invocation config overrides, cost and token accounting, remote secrets, and remote schedules. Use when changing deploy, serve, or anything that talks to a statelog server.
---

# Hosting developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/hosting/statelog.md` — The observability system: what events are captured and where they are sent.
- `docs/dev/hosting/statelog-clients.md` — The sealed per-route clients the CLI uses to talk to statelog, over one shared transport.
- `docs/dev/hosting/hosted-agent-execution.md` — Deploying an agent to a hosted statelog instance and running it over HTTP.
- `docs/dev/hosting/how-hosted-serving-works.md` — The plain walkthrough of serving: deploy, compile, the four routes, and how an interrupt becomes an HTTP round trip. Read before `hosted-agent-execution.md`.
- `docs/dev/hosting/per-invocation-config.md` — Letting one invocation carry its own config override and trace id.
- `docs/dev/hosting/invocation-usage-accounting.md` — How a hosted invocation reports its full cost and token breakdown, including across a subprocess.
- `docs/dev/hosting/remote-secrets.md` — Managing a hosted project's secrets against a write-only store, and the rules that keep values out of argv and output.
- `docs/dev/hosting/schedule-remote-backend.md` — Managing schedules that live on a hosted statelog server rather than locally.
