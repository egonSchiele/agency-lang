# Sandbox isolation options for Agency subprocess execution

This document explores the four practical techniques for sandboxing
agent-generated code in the `std::agency` `compile()` / `run()` feature, in
terms of what each technique isolates, what it doesn't, perf cost, and how it
would slot into the existing `_run` / IPC / handler-propagation architecture.

The motivation: today, the safety story of the subprocess feature ("parent
handlers wrap subprocess") is partial. Direct Node API access from inside the
subprocess (e.g., `import * as fs from "fs"`) bypasses the entire handler
chain. Real isolation is needed for the spec's stated property ("subprocess
cannot escape the parent's safety constraints") to be true.

---

## 1. Node's built-in `vm` module

**What it is:** Node ships a `vm` module that compiles code in a separate V8
"context" with its own global object. You decide what's in that global;
everything you don't add isn't reachable.

```ts
import vm from "node:vm"

const sandbox = {
  // expose only what you want
  console: { log: (...args) => process.send({ type: "log", args }) },
  agencyInterrupt: (...args) => sendInterruptToParent(...args),
}
vm.createContext(sandbox)
vm.runInContext(compiledJs, sandbox)
```

**What it isolates:** the global object. Inside the context,
`globalThis.fs` doesn't exist, `process` doesn't exist, `require` doesn't
exist. Code can only touch what you put in the sandbox.

**What it doesn't:**

- `vm` is *not* a security boundary, and the Node docs say so explicitly. The
  classic escape is `this.constructor.constructor("return process")()` — V8's
  prototype chain still reaches the outer host process. People have published
  exploits for years.
- ES module `import` statements don't work directly; you need
  `vm.SourceTextModule` (still experimental, behind a flag), and even then
  the loader has to be carefully sandboxed because you control resolution.
- Async leaks: timers, microtasks, and unhandled rejections still cross
  contexts.

**Perf:** cheap. Same V8 isolate, same heap, just a different global. Compile
cost is similar to a normal `require`.

**For Agency:** `vm` would **not** actually solve the npm-escape problem. It
hides the global, but `import` resolution lives outside the global. You'd
still need an import filter on top, and once you have that filter, `vm` adds
little.

Verdict: **don't use vanilla `vm` for security.** It's fine for "give the
guest code a clean slate" but not "stop adversaries".

---

## 2. `isolated-vm`

**What it is:** A native npm module by Marcelo Camargo (Discord, also used by
Cloudflare Workers' early days). Spins up a *separate V8 isolate* — its own
heap, its own GC, its own globals. Communication crosses the isolate boundary
via copy-or-transfer-explicitly semantics.

```ts
import ivm from "isolated-vm"

const isolate = new ivm.Isolate({ memoryLimit: 128 })  // hard MB cap
const context = await isolate.createContext()
const jail = context.global
await jail.set("global", jail.derefInto())

// expose a single function the guest can call
await jail.set("agencyInterrupt", new ivm.Reference(async (kind, msg, data) => {
  return await sendInterruptToParent({ kind, message: msg, data, origin: "guest" }, ...)
}))

const script = await isolate.compileScript(generatedJs)
await script.run(context, { timeout: 5000 })
```

**What it isolates:** essentially everything. Different heap → no
`this.constructor.constructor` escape. Different isolate → no shared mutable
state. The host's `fs` / `process` / `require` aren't reachable because *the
V8 context never had them*.

**What it provides on top of `vm`:**

- Hard memory limits enforced by V8 (`memoryLimit` in MB)
- Hard time limits per script invocation (`timeout`)
- Explicit, copy-based data marshalling (`ExternalCopy`, `Reference`)
- Termination via `isolate.dispose()` that actually kills the worker

**What it doesn't:**

- Native modules don't work — no `node:fs`, no native bindings. *That's the
  whole point*, but it means everything the guest needs (LLM calls, network,
  file I/O) has to be funnelled through reference functions you expose.
- ES module imports require building your own loader with
  `Module.compileSyntheticModule()` etc. Doable but real work.
- Maintenance: small dev team, occasionally lags Node major versions; native
  compile per platform.

**Perf:** real cost. Each isolate is heavier than a `vm` context but lighter
than a process. Cross-isolate calls require serialization (V8 deep-copy under
the hood).

**For Agency:** this is the most realistic option for the feature as scoped.
The handler-propagation design *already* has the right shape — you'd replace
`fork(bootstrap)` with `new ivm.Isolate()`, and replace
`sendInterruptToParent` with a `Reference` exposed in the isolate's global.
The IPC protocol becomes function calls instead of messages, but the
semantics (subprocess interrupt → parent handlers run → decision returned)
are identical.

The big design questions:

- How do you give the guest LLM access? Expose `llm` as a `Reference` that
  calls Smoltalk in the host. Same pattern for any tool that needs Node APIs.
- How do you give it `std::shell` / `std::fs`? Expose the *interrupt-gated
  wrappers* as references. Don't expose the raw Node APIs.
- What about npm imports the spec promised? You probably can't have those —
  generated code is restricted to what you expose.

The result: a much narrower but actually-safe API. "Generated code can build
agents using the std lib, but can't reach outside it."

Verdict: **the most engineering-tractable real sandbox** for this feature.

---

## 3. Worker threads (honourable mention)

**What it is:** Node's `worker_threads` — a worker is its own V8 isolate, its
own event loop, but shares the *process*.

**What it isolates:** the JS heap. Same as `isolated-vm` from a memory safety
standpoint.

**What it doesn't:** workers still have full Node API access by default.
`import "fs"` works. `process` is the *parent's* process. So out of the box,
workers are no more secure than `fork()`.

You can pass `{ resourceLimits: { maxOldGenerationSizeMb, ... } }` to
constrain memory, and `argv: []` plus `--experimental-permission` (Node 20+)
to enable the permission model:

```ts
new Worker(scriptPath, {
  execArgv: ["--experimental-permission", "--allow-fs-read=/tmp"],
  resourceLimits: { maxOldGenerationSizeMb: 256 },
})
```

The Node permission model lets you whitelist FS read/write paths,
child_process spawn, worker creation, and inspector. It's still experimental
but real, and it works for the worker-process case.

**For Agency:** workers are interesting because they avoid the IPC
serialization cost (you can transfer `ArrayBuffer`s zero-copy) and have lower
startup overhead than `fork`. Combined with `--experimental-permission`, you
get a partially-restricted Node environment without the "everything must go
through references" pain of `isolated-vm`.

Trade-off: the permission model is permissive-by-default for things it
doesn't yet cover (network, env vars), and crashing the worker can sometimes
destabilize the host (less mature than `isolated-vm`).

Verdict: **plausible if you want to stay closer to "real Node" but with some
teeth.** Less safe than `isolated-vm`, more capable than a pure JS sandbox.

---

## 4. OS-level boundaries

This is what actual production code-execution services (Lambda, Cloudflare,
GitHub Actions, Replit, anything running untrusted code at scale) use. The
boundary isn't the JS engine; it's the kernel.

### 4a. Separate Unix user

Spawn the subprocess as an unprivileged user that only has access to specific
directories.

```ts
fork(bootstrapPath, [], {
  uid: agencyGuestUid,
  gid: agencyGuestGid,
  cwd: "/var/agency-sandbox",
  env: { PATH: "/usr/bin:/bin" },
})
```

Requires the parent to be running as root (or with `CAP_SETUID`), which is
usually a non-starter for a developer tool. You also have to provision the
user account out-of-band. Real but rarely worth the operational cost for a
CLI tool.

### 4b. Linux containers

Run the subprocess in a container with strict mounts and capabilities.
Concretely:

```bash
podman run --rm --read-only --tmpfs /tmp --network none \
  --user nobody --cap-drop=ALL --memory=128m --cpus=0.5 --pids-limit=64 \
  <image> node /sandbox/script.js
```

Then route stdin/stdout/IPC through the container.

What you get:

- Filesystem: read-only root + writable tmpfs for `/tmp` only
- Network: `--network none` cuts network entirely
- Capabilities: `--cap-drop=ALL` drops every Linux capability
- Memory: `--memory=128m`
- CPU: `--cpus=0.5`
- PID limit: `--pids-limit=64`

What you give up:

- Container runtime as a dependency (Docker on macOS/Windows means a VM)
- Cold-start overhead (hundreds of ms to seconds for first run; can be
  amortized with a pool)
- Trickier IPC: container boundaries don't naturally pass FDs the way `fork`
  does. You'd use a Unix socket mounted into the container, or HTTP over a
  private network.

For a polished product (e.g., a hosted Agency service), this is the gold
standard. For a developer-laptop CLI tool, it's heavyweight.

### 4c. seccomp / landlock / pledge

The system-call-level approach, available on Linux (`seccomp-bpf`,
`landlock`), OpenBSD (`pledge` / `unveil`), and partially macOS
(`sandbox_init`).

The idea: after spawning the subprocess, drop privileges by telling the
kernel "this process can only ever make these syscalls" (seccomp) or "this
process can only ever access these paths" (landlock).

```ts
// pseudocode — actually requires a tiny native module or a wrapper
import { seccompApply } from "some-seccomp-lib"
// In bootstrap, before importing user code:
seccompApply({
  allow: ["read", "write", "epoll_*", "futex", "mmap", ...],
  deny: ["connect", "bind", "execve", "ptrace", ...],
})
```

What you get: the strongest constraint short of a separate kernel. seccomp
can't be bypassed by code in the same process — once the policy is loaded,
the kernel rejects forbidden syscalls, regardless of what JS does.

What you give up:

- Linux-only (or per-OS implementations); breaks portability
- Hard to write a correct policy that lets Node run but blocks malice; one
  missing syscall and Node's allocator dies
- No good off-the-shelf Node bindings; you'd write a small native helper or
  use `seccompiler` via a wrapper

Worth it for a production service, almost never worth it for a CLI.

---

## How they stack up for Agency

| Approach                       | Stops the npm-escape (S1)?       | Effort to integrate | Cross-platform   | Perf cost           |
| ------------------------------ | -------------------------------- | ------------------- | ---------------- | ------------------- |
| `vm` module + import filter    | Only with the filter             | Low                 | ✅                | Negligible          |
| `isolated-vm` + ref API        | ✅ (no module loader unless you write one) | Medium-high         | ✅                | Moderate            |
| Worker + permission model      | ⚠️ (experimental, partial)        | Low-medium          | ✅                | Low                 |
| Separate Unix user             | ✅                                | High (ops)          | Linux/macOS      | Low                 |
| Container                      | ✅                                | Medium-high         | Needs runtime    | High cold-start     |
| seccomp / landlock             | ✅                                | Very high           | Linux only       | Low                 |

For the spec — "agent writes Agency code, parent runs it with
handler-propagation safety" — the realistic choices are:

- **Phase 1 (now-ish):** AST-level import allowlist in `_compile`. Gets 80%
  of the safety with maybe 50 lines of code, no new runtime dependency. The
  handler-propagation design then *actually* delivers what it promises,
  because the only way generated code can do anything destructive is through
  `std::*` functions that fire interrupts.
- **Phase 2 (real isolation):** `isolated-vm`. Replace `fork(bootstrap)` with
  `new ivm.Isolate()`. The IPC protocol you've already designed becomes
  intra-process function calls, but the semantics are unchanged — subprocess
  interrupts route through parent handlers. You drop the `process.env`
  leakage problem (the isolate has its own env), the resource limits problem
  (memory + timeout are first-class), and the npm escape problem (no module
  loader by default).
- **Phase 3 (production hosting):** containers. Only if you ever offer "run
  agent-generated code on our servers" as a service.

The `isolated-vm` path is the one most worth pricing out. It would take a
meaningful refactor — the bootstrap wouldn't be a forked Node process
anymore, and you'd need to expose every host capability (LLM calls, file
reads, shell commands) as explicit references rather than importable modules.
But it's the only option that lets you keep the *promise* of the feature
("subprocess can't escape") without re-architecting around the OS.

A reasonable next step would be a 1-day spike: take a single Agency program
(`run-basic.agency`), wire it through `isolated-vm` end-to-end (compile, load
into isolate, expose a single `interrupt` reference, run, return result), and
see what the API ergonomics feel like before committing.
