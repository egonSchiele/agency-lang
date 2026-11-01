# Review: attach opens its socket at registration

Plan: `2026-11-01-attach-without-signal.md`. I read the plan, the BMO issue, `docs/dev/cli/debugger-attach.md`, `registerAttach`, `startAttachServer`, the registry, and the two CLI paths that send the signal.

## Is this the right fix?

Yes. The signal was the only part of attach that an outside process could trigger by accident, and the socket already does everything the signal led to. Opening it at registration removes the signal with no new mechanism. The server and its sockets are already `unref`ed, a probe with no session costs nothing, and the same-user boundary is unchanged, so the plan is right that nothing after the connection changes.

I considered the alternatives and none is better:

- A different trigger, such as the CLI touching a file the program watches, keeps the "ask first, then open" shape at the cost of a watcher in every program. It buys nothing, because the socket is private already.
- Keeping the signal behind an opt-in is what the owner rejected, and I agree: a fixed signal collides with whatever else uses it, and `nodemon` is not the only program that sends `SIGUSR2`.
- Not registering embedded programs at all would fix BMO but lose the feature for the case it was kept for.

One cheap addition is worth doing in this PR even though the owner deferred the per-invocation opt-out: an environment variable such as `AGENCY_NO_ATTACH=1` that makes `registerAttach` return at once. It is three lines, it costs nothing, and it gives a host like BMO a switch if the socket ever gets in the way again. The config field can still come later.

## Security

The trust boundary does not move. Before this change, any process running as the same user could send `SIGUSR2` and then connect. After it, the same process connects without the signal. The signal was never a barrier; it was a courtesy. Two things do change, and both are worth a sentence in the dev doc:

1. **Nothing visible happens when a stranger attaches.** Before, a socket appeared in the sessions directory when the signal arrived, which an owner could notice. Now the socket is always there. A same-user attacker who connects and sends `client: terminal` installs the driver and the program stops at its next statement, with no sign on disk. This was already possible with one `kill` more. The defence is the `0700` directory and the `0600` socket, as it was.

2. **The directory check now happens once, at start.** Today `startAttachServer` re-checks the directory when the signal arrives, which the doc calls "hours after registration". After the change the two checks run a tick apart. If the owner later runs `chmod 755 ~/.agency/debug-sessions`, the socket stays open at mode `0600`, so another user still cannot connect to it. The risk is the window at the umask's mode between `listen` and `chmod`, and that window is at the program's start, when the directory was just checked. I think it is fine. Keep the check inside `startAttachServer` all the same, because tests call it directly, and say so in the doc as Task 4 asks the implementer to decide.

One thing the plan does not say: whether a stranger connecting is any worse than before is not the question an embedder will ask. They will ask "why does my server have an open Unix socket I did not create?" The `ts-interop.md` paragraph in Task 4 answers that. Make sure it says what someone connecting can do (step, set variables, answer interrupts) and that the opt-out exists.

## Performance

Negligible. Registration already wrote a file; it now also calls `rmSync`, `listen`, and `chmod` once per process, all asynchronous after the record is written. A program that runs a node in a loop returns at the slot check. One extra open file descriptor per process.

Two things to check rather than assume:

- **Exit timing.** `server.listen` on a path binds in the same tick and runs its callback on the next one. A very short program could exit between the two. The `exit` hook runs `removeRecord`, which removes the socket file whether or not the callback ran, so nothing is left behind. The `chmod` just never happens on a socket that no longer exists. Fine, but a test that runs a one-line program under `AGENCY_HOME` and checks the directory is empty afterwards would pin it.
- **Every `agency run` and every `agency test` child now opens a socket.** Each has its own `AGENCY_HOME`, so nothing collides. The 104-byte path limit becomes a silent refusal on a long temp path instead of something that only mattered under a signal, which is the right behaviour, but it means a test that needs the socket can be refused by a long `TMPDIR`. `attach.test.ts` already depends on the socket, so the path already fits.

## Edge cases the plan has not covered

1. **A record with no socket shows as live forever.** If `startAttachServer` fails (path too long, filesystem without Unix sockets, such as some NFS homes), the plan logs under `DEBUG` and leaves the `.json` record in place. `agency debug --attach` then lists the program as live for as long as it runs, and the session CLI's probe gets `ECONNREFUSED` or `ENOENT`. Remove the record when the server cannot start, so the listing shows only programs that can be attached to. The plan's new refusal message ("may have been refused its sessions directory") then covers only the real race, a program that registered a moment ago.

2. **Stale files pile up until someone runs the listing.** The regression test in Task 3 shows what a `nodemon` restart leaves behind: both files, removed only by `removeStale`, which only the CLI runs. A server restarted fifty times a day leaves fifty pairs until the owner happens to list. The next process with a reused pid cleans its own two files, but pids are rarely reused soon. Sweep at registration: `removeStale(dir, listRecords(dir))` is one `readdir` and one `kill(pid, 0)` per record, and it runs once per process. Worth the line.

3. **The `pid` field in `SharedAttachTarget` is never read.** The old `attachTarget.pid` was not read either. Drop it, or say what it is for.

4. **Test ordering in one worker.** The plan says the new `platform.test.ts` case must not clear the slot, since `attach.test.ts` registers the same process. That is right, but spell out the consequence: the new case opens a real socket in the test `AGENCY_HOME` under the worker's pid, and whichever file runs first owns the server for the rest of the worker's life. `attach.test.ts` works either way because it registers last and the getter reads the slot. A comment at the slot in the test saying this is deliberate will stop someone "fixing" it.

5. **The retry no longer has a reason in most cases.** `connectWithRetry` waits two seconds because the program used to open the socket after the signal. Now a missing socket almost always means the program cannot be attached to, and the person waits two seconds for the refusal. The plan keeps the retry for a program that registered a tick ago. Cheaper: check the socket file exists before connecting, refuse at once when it does not, and keep the retry only for a connection that is refused on an existing file. Do the same in `debugSession`'s `attach` verb, which the plan already changes to a refusal when the file is missing.

6. **Shared `~/.agency` across machines or pid namespaces.** Today a record from another container can name this machine's pid by accident; the dev doc lists a `hostname` field as future work. After the change the socket file is in the same position, and `startAttachServer` removes a stale socket at its own pid's path before listening. Two containers that share a home and happen to use the same pid now remove each other's socket at start, where before they only overwrote each other's record. Still an edge, still future work, but the plan should mention it in the same place the doc does.

7. **`agency debug` of a program that imports a module which registers.** The `ctx.hasDebugger()` early return covers the debugged context. A program that starts a second context from TypeScript while being debugged would register that one and open a socket. This is the same as today with a signal, so not a regression. Skip unless it is cheap.

## Smaller notes on the plan text

- Task 1 step 4: `debugLine` for a rejected promise is right, but the catch must also cover a throw from `startAttachServer` before its first `await`, which today lands in the caller. `void startAttachServer(...).then(ok, fail)` covers both, since an async function turns an early throw into a rejection. Say so, or a reader may add a `try` around it.
- Task 2's new refusal says "Run it with DEBUG=1 to see why". A program that is already running cannot be re-run with `DEBUG=1` without restarting it. Say "start it with" and, after fix 1 above, the message is only needed for the race.
- Task 4's changelog line is good. Add that programs on the previous version still need the signal, since a person with a mixed install will try the new CLI on an old program and get the refusal.
- Task 5 asks for `make` and a smoke run. Also smoke `nodemon` or the equivalent: start a compiled program with `node`, `kill -USR2`, confirm exit with signal. The plan's Task 3 test does this, so the smoke is just confirming the built package matches.

## Verdict

Go ahead with the plan. Add the two small behaviours (remove the record when the server cannot start, sweep stale records at registration) and the `AGENCY_NO_ATTACH` switch, and tighten the retry. None of these changes the shape of the work.
