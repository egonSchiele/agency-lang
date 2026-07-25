# Debugging multi-process systems

Debugging long-running, multi-process systems is a different beast from
single-process JS, and the tools you reach for are different. This doc
collects practices for the Agency `std::agency` subprocess feature
specifically, but most apply to any Node parent/child architecture.

The current state of the world for that feature: an IPC debug logger
(`AGENCY_IPC_DEBUG=1`) that prints every IPC message tagged with role and
type. Good first lever — everything below builds on top.

---

## Functional debugging — "the code doesn't work"

### Correlation IDs on every message

Every interrupt gets a UUID at the point it's raised in the child, the same
UUID is in the parent's response, the same UUID appears in any log line about
that interrupt anywhere. Then `grep <uuid> debug.log` reconstructs the full
lifecycle.

Without IDs, when two interrupts overlap you're guessing which decision
matched which request. With IDs, it's trivially mechanical.

### Catch-all error handlers in the bootstrap

The current bootstrap doesn't register `process.on("uncaughtException")` or
`process.on("unhandledRejection")`. If guest code throws asynchronously (a
Promise rejection escaping a tool call), the bootstrap won't get a clean
error path — it'll exit with no IPC message and the parent will see
"Subprocess exited unexpectedly with code 1". Adding both handlers and
routing them to `{type: "error", error: <stack>}` turns silent crashes into
legible failures.

### "No-fork" debug mode

Have a flag (e.g., `AGENCY_NO_FORK=1`) that runs the would-be subprocess
code *in the parent process* instead. Same compile path, same loader, same
handler resolution, but you can drop a `debugger` statement in either side
and step through both.

You lose the IPC channel as a thing-being-tested, but you gain the ability to
use a normal stack trace and Chrome DevTools. Works great for "why does this
Agency program produce the wrong result?" type bugs.

### Heartbeats

The subprocess emits `{type: "heartbeat", ts}` every N seconds. The parent
tracks the last heartbeat per child. If you go more than 2× heartbeat
interval without one, you have a hang (vs. just a slow LLM call). The parent
can log this and proactively kill or escalate.

Right now, a hung subprocess looks identical to a slow one.

### Recording / replay

When `AGENCY_RECORD=path.jsonl` is set, every IPC message in both directions,
plus stdout/stderr lines, plus the final result, gets appended to a JSONL
file.

When you get a bug report, you ask for the recording and you can replay it
against the parent code in isolation, or feed it to a test that asserts the
message sequence matches a golden file. This is what makes complex async bugs
reproducible — you escape the "works on my machine" trap.

### Print the PID prominently

When `_run` forks, log `subprocess started: pid=12345` to stderr. Then
engineers can do `lsof -p 12345`, `dtruss -p 12345`, `strace -p 12345`,
attach a profiler — none of which require any code changes.

---

## Security debugging — "is the process doing something it's not supposed to?"

This is where you leave Node-land entirely. The OS already knows everything
any process does; you just have to ask it.

### Syscall tracing

The single most useful technique for "what is this process actually doing":

- **macOS**: `sudo dtruss -p <pid>` shows every syscall in real time.
  - `sudo dtruss -f -p <pid>` follows forks
  - `sudo dtruss -t open -p <pid>` filters to just file opens
  - Catch: needs SIP disabled for `dtruss` on signed binaries.
    `fs_usage <pid>` (no SIP needed) shows file-system events specifically.
- **Linux**: `strace -f -p <pid>`, or the more powerful `bpftrace` for
  production-grade observability.
- Both let you see every `open`, `read`, `write`, `connect`, `exec`, `fork`,
  etc.

If a guest claims it's only reading config but you see
`open("/Users/me/.ssh/id_rsa")`, you've caught it.

### Open files / network connections

`lsof -p <pid>` for a snapshot, `lsof -p <pid> -r 1` to refresh every
second. Shows every open file, socket, and pipe. `lsof -i -p <pid>` filters
to network.

This is great for "is the subprocess phoning home?" — if you see a TCP
connection to an unexpected host, you've found something.

### Process tree

`pstree -p <ppid>` (or `ps -ef | grep <ppid>` with `--forest` on Linux).
Catches the "subprocess shelled out to its own subprocess" case. If your IPC
log shows one subprocess but `pstree` shows three, the guest is doing
something behind your back.

### Network capture

Spinning case: you suspect exfiltration. Run
`sudo tcpdump -i any -w capture.pcap host not 192.168.0.0/16` while the
subprocess runs, then open the pcap in Wireshark. Brutal but conclusive.

### Hook the dangerous APIs in JS

Cheaper than syscall tracing for catching JS-level misbehavior. In the
bootstrap, before importing the guest code, monkey-patch `fs`,
`child_process`, `net`, `dns`, etc. to log every call:

```ts
import * as fs from "node:fs"
const origReadFile = fs.readFileSync
fs.readFileSync = (path, ...rest) => {
  process.send({type: "log", category: "fs.read", path: String(path)})
  return origReadFile(path, ...rest)
}
```

Now your IPC log includes "guest tried to read /etc/passwd" alongside the
interrupts. Combined with the recording mode above, you have an audit log per
run.

This is a *detection* tool, not *prevention* — the guest could un-monkey-patch
since it's all in the same process. But it's invaluable during development.

### seccomp in observe-only mode (Linux)

seccomp has a `SECCOMP_RET_LOG` action that logs the syscall to syslog
without blocking it. You can install a permissive seccomp filter and just
*watch* what the process does, without breaking anything. Then when you
understand the syscall surface, you tighten the filter to actually block.
macOS doesn't have a direct equivalent.

### Node-internal observability

If you want to instrument from inside Node:

- `node --trace-sync-io` flags blocking I/O in the event loop
- `node --inspect=<port>` exposes Chrome DevTools' Network/Debugger/Profiler
  domains; you can connect a script that programmatically captures all
  network requests
- `async_hooks` API can log every async resource (Promise, setTimeout,
  socket, etc.)
- `diagnostics_channel` lets modules publish events; HTTP servers, undici,
  etc. publish into it

`async_hooks` is heavy and you don't want it on in production, but for
"what's happening right now in this process" debugging, it's gold.

---

## Performance debugging

Different toolchain.

### Built-in V8 profiler

`node --cpu-prof --cpu-prof-dir=./profiles script.js` writes a `.cpuprofile`
file when the process exits. Drag-and-drop into Chrome DevTools' Performance
tab. Tells you exactly where CPU time went.

For your subprocess case:
`fork(bootstrap, [], { execArgv: ["--cpu-prof"] })` profiles the child. Same
trick with `--heap-prof` for heap allocation.

### Clinic.js

`npx clinic doctor -- node script.js` is genuinely good. It runs the
program, watches for the Node-flavoured anti-patterns (event-loop block, GC
pressure, I/O bottleneck), and gives you a diagnosis.

- `clinic flame` for flamegraphs
- `clinic bubbleprof` for async lifecycles

Works on subprocesses if you wrap your launcher.

### Latency checkpoints in IPC

Add `ts: Date.now()` (or `process.hrtime.bigint()`) to every IPC message.
After a run, derive: round-trip time per interrupt, time spent waiting for
parent decisions, time spent in subprocess work. This tells you where the
multi-second latencies live without needing a profiler.

### OS-level

Instruments.app on macOS (Time Profiler template), `perf record -p <pid>` on
Linux. Both show kernel + userspace, which lets you distinguish "subprocess
is doing CPU work" from "subprocess is waiting on a syscall" from "subprocess
is waiting on the parent".

### Heap snapshots for memory leaks

`node --heap-prof` writes snapshots periodically. Compare two snapshots in
DevTools to see what's growing.

For your case: a long-lived parent process accumulating closures from
`sendInterruptToParent` listeners (the per-call `process.on` registrations)
would show up here.

---

## General "is the process doing what it should" — orthogonal practices

### Make the process self-describing

Have `SIGUSR1` print a snapshot of internal state to stderr — handler stack
depth, in-flight interrupts, pending IPC messages, current node, current
step. `kill -USR1 <pid>` becomes your "what are you doing right now?" probe.
Doesn't disrupt the process, gives you live introspection.

### Postmortem reports

`process.report.writeReport()` (or `--report-on-fatalerror
--report-on-signal --report-uncaught-exception`) dumps a JSON file with
stack traces, heap stats, env vars, loaded libs, GC counters. When a
subprocess crashes, having one of these is worth a thousand log lines.

### Treat the IPC channel as an audit log, not just a transport

Everything interesting that happens in the subprocess goes through the
channel anyway (interrupts, results, errors). Add log/metric/heartbeat
message types for things that shouldn't *block* but should be observable.
Then your audit log writes itself.

### Test the wire protocol directly

Have unit tests that don't fork at all — they construct fake parent and child
sides of the IPC, send messages, assert on responses. Catches protocol bugs
(wrong message shape, missing field) without the flakiness of actual
subprocesses.

### Chaos testing

Kill the child mid-flow. Drop a `decision` message on the floor. Send a
malformed message. Send two `result` messages.

The parent's robustness against these is what determines whether real-world
bugs become "gracefully reports failure" or "hangs forever and corrupts
state". Worth a small test suite of chaos scenarios.

---

## Concrete next steps for Agency, ranked by ROI

In rough order:

1. **Add `process.on("uncaughtException")` and
   `process.on("unhandledRejection")` to the bootstrap**, routing to
   `{type: "error", ...}`. Half a day, immediate clarity gain.
2. **Add correlation IDs to IPC messages.** Then update your IPC logger to
   include them. Half a day.
3. **Print subprocess PID + bootstrap path on fork**, prominently, to stderr.
   Trivial. Enables every OS-level debug technique.
4. **Heartbeats from child to parent every 5s.** Half a day. Distinguishes
   hangs from slow work, makes the timeout fix easier later.
5. **Recording mode (`AGENCY_RECORD=path.jsonl`)** that captures the full
   IPC stream + stdout/stderr to a file. One day. Pays for itself the first
   time a user reports a bug.
6. **A small `node:test`-style suite that mocks the IPC channel** and
   exercises the protocol without forking. Fast, deterministic.
7. **Optional: `AGENCY_AUDIT_FS=1` mode** that monkey-patches
   `fs`/`child_process`/`net` in the bootstrap and emits IPC log messages
   for every call. Not a security boundary, but a giant flashlight on what
   guest code is doing during development.

Most of these stack with the IPC logger you already have rather than
replacing it. The point is to give yourself enough orthogonal observability
that when something breaks, you have *multiple independent angles* to look at
the same incident — IPC log says X, syscall trace says Y, heartbeat timeline
says Z, and the picture pops out.
