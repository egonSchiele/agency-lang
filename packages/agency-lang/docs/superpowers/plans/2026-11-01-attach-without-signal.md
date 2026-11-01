# Attach opens its socket at registration, not on `SIGUSR2`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A program that embeds Agency no longer installs a `SIGUSR2` listener. A nodemon restart, which sends that signal, ends the program the way it ends any other Node process. `agency debug --attach` and `agency debug session attach` still work, by connecting to a socket the program opened when it registered.

**Architecture:** `registerAttach` already writes `<pid>.json` and, on the signal, calls `startAttachServer` to listen on `<pid>.sock`. The change moves that call to registration time and deletes the signal. The server and its sockets are already `unref`ed, so an idle socket does not keep a finished program alive, and a probe connection with no session open costs nothing. The CLI stops sending the signal and connects directly. Nothing after the connection changes.

**Tech Stack:** TypeScript in `lib/runtime/platform.node.ts`, `lib/debugger/attach/`, `lib/cli/attach.ts`, `lib/cli/debugSession/index.ts`; vitest.

**Issue:** `/Users/adit/bmo/docs/issues/2026-11-01-agency-debugger-signal-conflict.md`. BMO runs its backend under `nodemon`, whose default restart signal is `SIGUSR2`. The server survived its own restart with the debug socket open, its parent gone, and its model workers dead.

**Review:** `2026-11-01-attach-without-signal-review.md`, whose additions are folded in below: the `AGENCY_NO_ATTACH` switch, removing the record when the server cannot start, sweeping stale records at registration, and refusing at once when the socket file is missing.

## Decisions the owner made (2026-11-01)

- **Delete the signal; do not keep it behind an opt-in.** A fixed signal collides with whatever else uses it, and the socket does the whole job. Nothing in Agency should send or listen for `SIGUSR2` after this change.
- **Register from TypeScript hosts as before, with an environment switch to turn it off.** Attaching was considered and kept for programs that call a node from TypeScript. The boundary is the same user, and a same-user process can already open Node's inspector with `SIGUSR1`, so turning attach off for embedded programs would cost the feature without closing anything. `AGENCY_NO_ATTACH=1` makes `registerAttach` return at once, so a host that does not want the socket has a switch. A per-invocation option (`debugAttach: false`) can come later.
- **Keep the live-process check in the CLI.** `checkedRecord` and its `ps lstart` check were written so a stale record never signalled a stranger. With no signal, a stale record only produces a refused connection, so the check could be simplified. Leave it alone here; it still keeps the listing honest, and removing it is a separate change.
- **A socket that cannot be opened is silent unless `DEBUG` is set, and the record goes with it.** Today the failure prints to stderr because a person had just sent the signal. At registration nobody asked, and an embedded program in a serverless function, a read-only home, or under a long `AGENCY_HOME` path would otherwise warn on every start. The record is removed too, so the listing shows only programs that can be attached to.

## Background for the implementer

Read `docs/dev/cli/debugger-attach.md` whole, with care for "Registration", "The socket", and "The command". Then read `registerAttach` in `lib/runtime/platform.node.ts` (lines 55 to 180 today), `startAttachServer` in `lib/debugger/attach/server.ts`, and `listRecords`, `removeStale`, and `removeRecord` in `lib/debugger/attach/registry.ts`.

How registration works today. `runNode` (`lib/runtime/node.ts:588`) calls `registerAttach` on every node run. The function returns at once when the host is not the Node host, a debugger is installed, the process is an IPC child (`AGENCY_IPC`), or the code is not on the main thread. The first registration in a process writes the record and installs the `SIGUSR2` listener; later registrations only update `attachTarget.functions`, so a debugger attaching later gets the context that most recently started a node. The listener calls `startAttachServer` once and keeps the result.

Why there is a slot on `process`. One process can hold two copies of the runtime (a test worker re-evaluates modules per file; a package can be under `node_modules` twice). Each copy has its own module-level `attachTarget`. Today a `Symbol.for` slot on `process` holds the one live signal listener, and every registration claims it, so the most recent copy's listener answers. After the change the slot must hold the shared attach target instead, because `startAttachServer` begins with `fs.rmSync(paths.sock)`: a second copy opening its own server would remove the first copy's socket and take the path. One server per process, reading the target through the slot, keeps the current behaviour (the most recent registration's functions are served) without a race.

What `attachFunctionsFor(ctx)` is for. The functions a driver needs are bound in the runtime copy that owns the context and handed to `registerAttach`, precisely because the `#platform` file can be a different copy than the one the program imported (`lib/runtime/attachedDebugger.ts:129`). So one copy's server serving another copy's functions is already the design, and the shared slot relies on it.

What `startAttachServer` does. It checks the platform, checks the sessions directory again (`ensureSessionsDir`), checks the socket path length (104 bytes), removes a stale socket at its own pid's path, listens, and `chmod 0600`s the socket. Every failure comes back as `{ unavailable: string }`. It is an `async` function, so a throw before its first `await` becomes a rejection too; `void startAttachServer(...).then(ok, fail)` covers both and needs no `try` around it. The server and every accepted socket are `unref`ed; the session `ref`s the server only while the driver waits on an answer. Nothing in this function changes.

Exit timing. `server.listen` binds the path in the same tick and runs its callback on the next one. A program that finishes between the two exits before the `chmod`; the `exit` hook runs `removeRecord`, which removes the socket file whether or not the callback ran, so nothing is left behind.

Where the signal is sent. `lib/cli/attach.ts:271` (`process.kill(pid, ATTACH_SIGNAL)`), `lib/cli/debugSession/index.ts:79` (the `signal` dependency) and `:206-212` (the `attach` verb signals when the socket file is missing). Tests that reference it: `lib/debugger/attach/attach.test.ts:385` (`process.emit(ATTACH_SIGNAL)`), `lib/cli/debugSession/index.test.ts:41`. `lib/cli/attach.test.ts` starts a real child and attaches through `attachCommand`, which sends the signal internally.

Where the signal is documented. `docs/dev/cli/debugger-attach.md` ("Registration", "The socket", "The command", "Tests"), `docs/site/cli/debug.md:87`, `docs/superpowers/specs/2026-10-20-attach-to-a-running-program.md` (historical; gets a note, not a rewrite). `lib/utils/packageImports.d.ts:58` declares `registerAttach` for the `#platform` import map and does not mention the signal. Grep `docs/` and `lib/` for `SIGUSR2` and `ATTACH_SIGNAL` at the end to catch any reference this list missed.

## Global Constraints

- No dynamic imports. Objects, not maps; arrays, not sets; types, not interfaces.
- A program must never fail, or print, because it cannot be debugged. Every new failure path in registration goes through `debugLine`.
- Run `pnpm run fmt:ts` on every `.ts` file you touch, by file, never on a directory.
- Run `pnpm run lint:structure` before the PR.
- Do not run the full agency test suite. Run the vitest files named in each task and save their output to a file in the scratchpad.

## Task 1: `registerAttach` opens the socket and the signal goes away

**Files:** `lib/runtime/platform.node.ts`, `lib/runtime/platform.test.ts`

- [ ] Replace the listener slot with a target slot. Delete `ATTACH_SIGNAL`, `attachListener`, `ATTACH_LISTENER_SLOT`, `claimAttachListener`, and the module-level `attachTarget`. Add:

  ```ts
  /** The attach target this process serves, shared by every copy of the
   *  runtime in it. A process can hold more than one copy (a test worker
   *  re-evaluates modules per file; a package can be under node_modules
   *  twice), and `startAttachServer` removes a socket at its own pid's
   *  path before listening, so two copies each opening a server would
   *  fight over one path. The first registration opens the server; every
   *  registration sets the functions, so the context that most recently
   *  started a node is the one a debugger gets. */
  const ATTACH_TARGET_SLOT = Symbol.for("agency.debug.attachTarget");
  type SharedAttachTarget = { functions: AttachFunctions };

  function sharedAttachTarget(): SharedAttachTarget | null {
    const slot = process as unknown as Record<symbol, SharedAttachTarget | undefined>;
    return slot[ATTACH_TARGET_SLOT] ?? null;
  }
  ```

  Keep `refusedDir`.

- [ ] Add the switch to the early returns, the same shape as `isIpcMode` in `lib/runtime/subprocessRunInfo.ts`: `host.settings.read(NO_ATTACH_VAR) === "1"` returns at once. Export `NO_ATTACH_VAR = "AGENCY_NO_ATTACH"` from `platform.node.ts` so the test names the same string. Only `"1"` turns it off, as with `AGENCY_IPC`; say so in the docs.

- [ ] Rewrite the body of `registerAttach` after the early returns:

  1. If `sharedAttachTarget()` is non-null, set its `functions` and return.
  2. Directory check as today.
  3. Sweep: `removeStale(dir, listRecords(dir))`. A program restarted by a supervisor dies by signal and leaves its two files, and only the CLI's listing removed them before; this is one `readdir` and one `kill(pid, 0)` per record, once per process.
  4. Record write as today.
  5. Create the shared target, store it in the slot.
  6. Call `startAttachServer({ dir, record, functions: () => shared.functions })` at once. On `unavailable`, and on rejection, `debugLine` the message and `removeRecord(dir, record.pid)`, so the listing never shows a program that cannot be attached to. Do not print to stderr in either case.
  7. `host.system.onExit(() => removeRecord(dir, record.pid))` as today. `removeRecord` already removes both the record and the socket.

  The server handle itself is not needed after it starts; there is no `stop` on a program's own server, since the process exit removes the files.

- [ ] Update the doc comment on `registerAttach` so it describes opening the socket at registration, the sweep, the switch, and why a failure is quiet.

- [ ] In `lib/runtime/platform.test.ts`:
  - The existing "writes nothing" case gets one more line: with `AGENCY_NO_ATTACH=1` in the environment, `registerAttach` on the Node host writes nothing.
  - Add a case: two registrations in one process with different `functions` objects leave the slot holding the second one. Read the slot through `Symbol.for("agency.debug.attachTarget")` on `process` and assert on the identity of `functions`. Do not clear the slot afterwards, and say so in a comment at the slot read: the test worker is one process, this case opens a real socket in the test `AGENCY_HOME` under the worker's pid, `attach.test.ts` registers the same process later and works because the getter reads the slot, and a cleared slot would make that registration open a second server on the same path.

- [ ] Run `pnpm vitest run lib/runtime/platform.test.ts > <scratchpad>/task1.log 2>&1`.

## Task 2: the CLI connects without signalling

**Files:** `lib/cli/attach.ts`, `lib/cli/debugSession/index.ts`, `lib/cli/debugSession/index.test.ts`

- [ ] In `lib/cli/attach.ts`, remove the `ATTACH_SIGNAL` import and the `process.kill` block. Keep `checkedRecord` and `connectWithRetry`. Update the comment above `checkedRecord` (`lib/cli/attach.ts:135-145`): the check is no longer "before anything is sent"; it keeps a stale record from being listed as live and from being connected to by mistake when a pid was reused. One sentence, not a rewrite.

- [ ] Before connecting, check that the socket file exists. When it does not, refuse at once, with no two-second wait: `pid N has no debug socket. The program may have been refused its sessions directory; start it with DEBUG=1 to see why.` The retry in `connectWithRetry` stays for a connection refused on a file that exists, which is a program that registered a moment ago and has not finished `listen`. Put the existence check and the message in one exported helper in `attach.ts` so the session CLI uses the same words.

- [ ] In `lib/cli/debugSession/index.ts`, remove `signal` from `SessionCliDeps` and from `defaultSessionCliDeps`. In the `attach` verb, replace the signal-when-missing block with the helper's refusal. Remove the `ATTACH_SIGNAL` import.

- [ ] In `lib/cli/debugSession/index.test.ts`, remove the `signal` dependency and the import. The child in that test registers and now opens its socket on its own; where `startChild` waits for the `.json` record, make it wait for the `.sock` file too, since the socket is opened a tick after the record.

- [ ] Run `pnpm vitest run lib/cli/debugSession/index.test.ts > <scratchpad>/task2.log 2>&1`.

## Task 3: the attach tests follow the socket, and a child dies on `SIGUSR2`

**Files:** `lib/debugger/attach/attach.test.ts`, `lib/cli/attach.test.ts`

- [ ] In `lib/debugger/attach/attach.test.ts`, remove the `ATTACH_SIGNAL` import and the `process.emit` line. The `ready()` poll that follows already waits for the socket to exist with mode `0600`; keep it. Rename the test to "writes its record, opens the socket, and takes a debugger" and fix the comment above the `describe` that says "the record and the signal listener are per process".

- [ ] In `lib/cli/attach.test.ts`, `startChild` waits for the record file. Make it also wait for the socket file. The existing attach-and-detach case stays as the direct-attach proof.

- [ ] Add a case to `lib/cli/attach.test.ts`, in the same `describe` that starts a real child, named "a registered child is ended by SIGUSR2 like any Node process":

  1. `startChild()`, which now waits for record and socket.
  2. `child.kill("SIGUSR2")`.
  3. Await the child's `exit` event and assert `signal === "SIGUSR2"` and `code === null`.
  4. A process killed by a signal never runs its `exit` hooks, so the record and socket files remain. Assert they still exist, then call `removeStale` from `lib/debugger/attach/registry.ts` on the sessions directory and assert both are gone. This pins down the cleanup path a nodemon restart leaves behind, which Task 1's sweep runs at the next registration.

  This is the regression test for the issue: before the change the child would open a socket and keep running.

- [ ] Add a case "a program that finishes at once leaves nothing in the sessions directory": compile a fixture whose `main` returns a constant, run it with `node` under the test `AGENCY_HOME`, await exit code 0, and assert the sessions directory holds no file for its pid. This pins the exit-timing note in the background.

- [ ] Run `pnpm vitest run lib/debugger/attach/attach.test.ts lib/cli/attach.test.ts > <scratchpad>/task3.log 2>&1`.

## Task 4: docs and changelog

**Files:** `docs/dev/cli/debugger-attach.md`, `docs/site/cli/debug.md`, `docs/site/guide/ts-interop.md`, `docs/superpowers/specs/2026-10-20-attach-to-a-running-program.md`, `changelog.md`, `CLAUDE.md` and `.claude/skills/agency-cli-docs/SKILL.md` (the index line for `debugger-attach.md`)

- [ ] `docs/dev/cli/debugger-attach.md`:
  - "The pieces": the `platform.node.ts` line says `registerAttach` opens the socket.
  - "Registration": rewrite the paragraph. Registering sweeps stale records, writes `<pid>.json`, and listens on `<pid>.sock` at once. Replace the listener-slot paragraph with the target-slot paragraph (why one server per process, why the most recent registration's functions are served). Say that a socket that cannot be opened is logged under `DEBUG`, the record is removed, and the run goes on. Name `AGENCY_NO_ATTACH`. Add the history in one sentence: until this change the socket was opened on `SIGUSR2`, and `nodemon`, which restarts a child with that signal, left the program running with its debugger open instead.
  - "The socket": "the signal listener also catches a rejection" becomes "registration also catches a rejection". The directory is now checked twice a tick apart; say the check inside `startAttachServer` is kept because tests call it directly and because it is the check right before `listen`, where the socket's short window at the umask's mode begins. Add the two security notes from the review: a connection now leaves no sign on disk, where before the socket appeared when the signal arrived, and this was already possible with one `kill` more, so the `0700` directory and `0600` socket are the defence as they were; and a `chmod 755` on the directory after start leaves the socket at `0600`, so another user still cannot connect.
  - "The command": "Then the signal, a connect that retries for two seconds while the program opens the socket" becomes: a missing socket file is refused at once, and a connect to an existing file retries for two seconds, for a program that has just started. The start-time check paragraph says it guards a signal to a stranger; add that with no signal it now keeps a stale record from being listed as live and from being connected to by mistake.
  - "The sessions directory": beside the `hostname` future-work sentence, add that two containers sharing a home and a pid now remove each other's socket at start, where before they only overwrote each other's record. Same edge, same future work.
  - "Tests": update the description of `attach.test.ts` (no signal handler call) and `lib/cli/attach.test.ts` (the `SIGUSR2` child case and the short-program case).
  - Add a short section "Why there is no signal" with the nodemon failure as the example, the same-user boundary, why no opt-in was kept, and the `AGENCY_NO_ATTACH` switch.
- [ ] `docs/site/cli/debug.md:87`: rewrite "How it works". A running program opens a private Unix socket under `~/.agency/debug-sessions` when it registers; `--attach` connects to it. The directory is readable by that user alone. Drop the nodemon sentence and keep the "whoever can reach that directory can do what the program's owner can do" warning. Name `AGENCY_NO_ATTACH`.
- [ ] `docs/site/guide/ts-interop.md`: under "Using Agency in TS", add one paragraph. A node run on Node registers the process for `agency debug --attach`: it writes a record and listens on a private socket under `~/.agency/debug-sessions`, both removed on exit. Whoever connects can step the program, change its variables, and answer its interrupts, and only the same user can reach the directory. Set `AGENCY_NO_ATTACH=1` to turn it off. A directory it cannot use is skipped silently; start with `DEBUG=1` to see why. The socket is unreferenced, so it never keeps the process alive.
- [ ] `docs/superpowers/specs/2026-10-20-attach-to-a-running-program.md`: add a note at the top, dated 2026-11-01, saying the signal trigger was replaced by opening the socket at registration, linking the plan, and that the spec below describes the original design.
- [ ] `changelog.md`, under "Unreleased", a "### Debugger" heading: "**Attach no longer uses `SIGUSR2`.** A program opens its debug socket when it registers, and `agency debug --attach` connects to it directly. A program under `nodemon`, which restarts a child with `SIGUSR2`, now restarts as it should instead of opening its debugger. Set `AGENCY_NO_ATTACH=1` to keep a program from registering at all. A program on an earlier version still waits for the signal, so the new CLI refuses it with "no debug socket"; restart it on this version."
- [ ] `CLAUDE.md`: update the index line for `docs/dev/cli/debugger-attach.md` ("`registerAttach` and the `SIGUSR2` trigger" becomes "`registerAttach`, which opens the socket at registration, the sweep, and `AGENCY_NO_ATTACH`") and the matching line in `.claude/skills/agency-cli-docs/SKILL.md`.
- [ ] Grep `lib/`, `docs/`, `CLAUDE.md`, and `.claude/skills/` for `SIGUSR2` and `ATTACH_SIGNAL`. The only hits left should be the historical spec, the changelog, the review, this plan, and the "Why there is no signal" section.

## Task 5: checks and PR

- [ ] `pnpm run fmt:ts` on each `.ts` file touched. `pnpm run lint:structure`. `make` once so `dist/` is rebuilt, then smoke the built CLI: start a compiled program with `node`, run `agency debug --attach` with no pid and confirm it is listed, then `agency debug session attach <pid>` and `detach`, and finally `kill -USR2 <pid>` and confirm the process exits by signal and that the next `agency debug --attach` listing no longer shows it.
- [ ] Open the PR against `main` with the description written to a file first (apostrophes break the command line). The description states the nodemon failure, the decisions above, and that the socket now exists for the program's whole life with the same same-user boundary. Say that the PR was opened so the owner can request a Copilot review.
