# OpenClaw Research & Agency Stdlib Recommendations

**Date:** 2026-03-27
**Status:** Research

## What is OpenClaw?

OpenClaw is an open-source (MIT-licensed), local-first personal AI assistant created by Peter Steinberger. It runs as a self-hosted daemon on your own device (macOS, Linux, Windows via WSL2) and connects AI agents to 24+ messaging platforms. The tagline is "The AI that actually does things."

- Website: https://openclaw.ai
- GitHub: https://github.com/openclaw/openclaw
- Docs: https://docs.openclaw.ai
- Skills marketplace: https://clawhub.ai

## Architecture

**Gateway (Control Plane):** A single long-lived daemon that owns all messaging surfaces, sessions, tools, and events. Exposes a typed WebSocket API at `ws://127.0.0.1:18789`. Serves a Control UI and WebChat over HTTP on the same port. Persists state under `~/.openclaw/`.

**Client Layer:** macOS menu bar app, CLI (`openclaw ...`), WebChat UI, and automations all connect as WebSocket clients.

**Node Layer:** Companion devices (macOS/iOS/Android/headless) connect with `role: node`, declaring capabilities and commands. They expose device-local actions (camera, screen recording, notifications, location) via `node.invoke`.

**Key design principle:** Shell execution runs where the Gateway lives; device actions run where the device lives. You can run the Gateway on a remote Linux server and still pair local device nodes for device-specific actions.

## Messaging Platform Integrations (24+ channels)

All channels connect through the Gateway. Each has its own authentication and configuration. Notably, OpenClaw uses **direct platform libraries** rather than aggregator services like Twilio.

| Channel | Implementation | Auth/Setup |
|---|---|---|
| WhatsApp | Baileys library | Device linking via `openclaw channels login` |
| Telegram | grammY library | Bot token via env var or config |
| Slack | Bolt library | Bot token + App token |
| Discord | discord.js | Bot token; supports native/text commands, guilds |
| Google Chat | Chat API | Google Cloud service account |
| Signal | signal-cli | Requires signal-cli binary |
| iMessage | BlueBubbles server (recommended) or macOS-native | Server URL + password + webhook |
| IRC | Built-in | Standard IRC config |
| Microsoft Teams | Bot Framework | Teams app + Bot Framework registration |
| Matrix | Built-in | Matrix homeserver config |
| LINE | Built-in | LINE channel config |
| WeChat | Official Tencent plugin | QR code scan via `openclaw channels login` |
| WebChat | Gateway WebSocket | No separate config needed |

Also supports: Feishu, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo.

**Group chat support:** Mention-based activation, per-channel chunking, group allowlists, reply tags.

**Multi-account support:** WhatsApp, Telegram, Discord support multiple account IDs per Gateway instance.

## Tools/Actions

### Execution & Processes
- `exec` / `process`: Run shell commands, manage background processes. Three approval modes: `deny`, `ask` (always prompt), `full`.
- `safeBins` list for low-risk commands; interpreter allowlists with strict inline eval.
- Elevated access toggle (`/elevated on|off`) for per-session host-permission escalation.

### File Operations
- `read`, `write`, `edit`: Standard file operations in workspace.
- `apply_patch`: Multi-hunk file patches. `workspaceOnly` by default.

### Browser Control
- Dedicated agent-only Chromium browser via Chrome DevTools Protocol (CDP) + Playwright.
- Tab management, navigation, screenshots, PDF generation.
- AI-driven click, type, drag, select, hover, scroll using snapshot references.
- Form filling, cookie/storage management, file uploads/downloads.
- Network inspection, dialog handling, environment simulation (geolocation, timezone, locale).
- SSRF protection with configurable private-network policies.

### Web Search & Fetch
- `web_search`: Supports Brave, Perplexity, Gemini, Grok, Kimi, Firecrawl.
- `web_fetch`: Retrieve and extract page content.

### Messaging
- `message`: Send messages across all connected channels.
- `react`: Add emoji reactions.

### Canvas (Visual Workspace)
- Agent-driven HTML/CSS/JS workspace rendered in WKWebView (macOS) or device WebView.
- Present/hide, navigate, evaluate JavaScript, snapshot as image.
- Deep links for triggering new agent runs from Canvas.

### Image & Media
- `image`: Analyze images via vision models.
- `image_generate`: Generate or edit images via DALL-E etc.

### Session & Agent Management
- `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`.
- `agents_list`: List available sub-agents.

### Cron & Automation
- Built-in scheduler persisted at `~/.openclaw/cron/`.
- Schedule types: one-shot (`at`), fixed interval (`every`), cron expressions.
- Execution modes: main session, isolated session, or custom session binding.
- Delivery modes: `announce` (to chat), `webhook` (HTTP POST), `none` (internal).

### Webhooks
- External trigger surface for inbound HTTP requests.

### Gmail Integration
- Gmail event triggers via Google Cloud Pub/Sub.

## Device Integrations (Nodes)

**macOS:** Shell execution, system notifications (passive/active/timeSensitive), canvas, camera, screen recording.

**iOS:** Canvas, voice wake (wake word detection), talk mode, camera (front/rear), screen recording, location services, Bonjour/mDNS discovery.

**Android:** Canvas, camera (photo + video), screen recording, SMS sending, notifications (list and execute actions), personal data access (photos, contacts, calendar, call logs), sensors (activity tracking, pedometer), location.

## Voice Features

- **Voice Wake:** Wake word detection on macOS and iOS.
- **Talk Mode:** Continuous voice conversation loop (listen → transcribe → LLM → speak). Automatic send on silence. Mid-response interruption on macOS.
- **TTS:** ElevenLabs exclusively, with streaming playback and per-message voice customization.
- **Media Pipeline:** Voice note transcription, image/audio/video/document handling across channels.

## Safety & Approval Mechanisms

**DM Pairing:** Unknown senders receive a time-limited pairing code. Approve via CLI. Policies per channel: `pairing` (default), `allowlist`, `open`, `disabled`.

**Exec Approval:** Binds exact request context and direct file operands. Three modes: `deny`, `ask`, `full`. File integrity validation prevents executing changed files.

**Docker Sandboxing:** Optional per-agent or per-session containers. Workspace mount modes: `none`, `ro`, `rw`. Network isolation enforced.

**Tool Access Control:** Allow/deny lists per agent. Tool profiles: `full`, `coding`, `messaging`, `minimal`.

**Filesystem Restrictions:** `workspaceOnly` mode restricts file ops to workspace directory.

**Security Audit:** `openclaw security audit` checks gateway auth, browser control, elevated allowlists, filesystem permissions, exec approvals, plugin allowlists, token strength, etc.

**Prompt Injection Mitigations:** External content safety wrapping, read-only agents for untrusted content.

## Skills/Plugin System

- Each skill is a directory with a `SKILL.md` file (YAML frontmatter + instructions).
- Three-tier loading: workspace skills > managed/local skills > bundled skills.
- Skills can require specific binaries, env vars, config keys, or OS.
- **ClawHub** (https://clawhub.com): Public community skill registry. Install via `openclaw skills install <slug>`.
- **Plugins** run in-process with the Gateway. Notable: Lobster (typed workflow runtime), LLM Task (structured JSON), OpenProse (markdown workflows).
- Agents can write and modify their own skills.

## Multi-Agent Capabilities

- Multiple isolated agents per Gateway, each with: dedicated workspace, separate state, isolated sessions, individual auth profiles.
- Per-agent model selection, tool restrictions, sandbox modes, personality files.
- Deterministic inbound routing by peer ID, guild/role, team ID, account ID.
- Agent-to-agent messaging via `sessions_send`.

## AI Model Support

35+ providers: Anthropic Claude, OpenAI GPT/Codex, Google Gemini, and many more, plus local models via Ollama, vLLM, SGLang, and OpenAI-compatible endpoints. OAuth subscription auth for ChatGPT/Codex. Model failover and auth profile rotation. Configurable thinking levels. Streaming. Per-response token/cost reporting.

---

## Recommendations for Agency's Standard Library

Based on OpenClaw's feature set, here are capabilities that could be added to Agency's stdlib, organized by implementation complexity. All of these would benefit from Agency's interrupt mechanism as a safety safeguard.

### Tier 1: Zero dependencies (use Node built-ins or shell commands)

These are the simplest to implement and have no additional npm dependencies.

| Function | Description | Implementation |
|---|---|---|
| `notify(title, message)` | Show a system notification | `osascript` on macOS, `notify-send` on Linux |
| `clipboard()` / `setClipboard(text)` | Read/write system clipboard | `pbpaste`/`pbcopy` on macOS, `xclip` on Linux |
| `env(name)` | Read an environment variable | `process.env` |
| `systemInfo()` | Get hostname, OS, platform info | Node `os` module |

Note: `webhook(url, body)` was considered but dropped — the existing `fetch` function in the stdlib already covers HTTP requests with an interrupt safeguard, so a dedicated webhook function adds little value.

**`notify` is the recommended starting point.** It validates the full stdlib pattern (Agency wrapper + interrupt + TypeScript implementation) with zero complexity, and provides genuinely new functionality that nothing in the current stdlib covers.

### Tier 2: Small dependencies

| Function | Description | Dependency | Size |
|---|---|---|---|
| `sendEmail(to, subject, body)` | Send email via SMTP | `nodemailer` | ~500KB |
| `extractPdf(path)` | Extract text from a PDF | `pdf-parse` | ~50KB |
| `generateQR(text)` | Generate a QR code image | `qrcode` | small |

**`sendEmail` via Nodemailer with SMTP** is recommended over a Gmail-specific implementation. SMTP is universal — Gmail, Outlook, SES, Fastmail, and self-hosted servers all support it. Users configure via env vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`).

### Tier 3: API-key-dependent (zero npm deps, but requires external accounts)

These use Node's built-in `fetch` to call external APIs. No npm dependencies, but the user must have an API key.

| Function | Description | API Provider |
|---|---|---|
| `searchWeb(query)` | Web search | DuckDuckGo (no key needed), or Brave/Perplexity (key needed) |
| `generateImage(prompt)` | Generate an image | OpenAI DALL-E |
| `textToSpeech(text)` | Convert text to audio | OpenAI TTS or ElevenLabs |

**`searchWeb` via DuckDuckGo** is notable because it requires no API key at all — just an HTTP fetch.

### Tier 4: Heavy dependencies or complex setup (defer these)

| Capability | Why defer |
|---|---|
| Browser automation | Playwright/Puppeteer are huge (~200MB+) |
| Messaging platform integrations | Each needs its own SDK, auth flow, persistent connection |
| Device integrations (camera, GPS) | Requires companion apps and platform-specific code |
| Voice/TTS with streaming | Requires audio pipeline, platform-specific playback |
| Cron/scheduling | Needs a long-running process model, which Agency doesn't currently have |

### Recommended implementation order

1. **`notify`** — zero deps, simple shell exec, genuinely new functionality, validates the pattern
2. **`sendEmail`** — small dep (nodemailer), high user demand, important interrupt use case
3. **`searchWeb`** — zero deps, no API key via DuckDuckGo, useful for research agents
4. **`generateImage`** — zero deps, uses OpenAI API, distinct capability, high appeal

### Architecture note: sending vs receiving

Agency should focus on **outbound actions** (sending emails, posting webhooks, showing notifications) in the stdlib. These fit naturally as functions with interrupt safeguards.

**Inbound event handling** (receiving messages, listening for webhooks, watching for emails) requires a fundamentally different architecture — long-running processes, event loops, persistent connections. This is better left to the TypeScript layer: users set up a listener in TypeScript that invokes their compiled Agency program when an event arrives. OpenClaw's Gateway architecture is essentially this pattern — a long-lived daemon that routes inbound events to agent sessions.
