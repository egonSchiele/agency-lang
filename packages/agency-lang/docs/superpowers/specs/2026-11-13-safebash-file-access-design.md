# safeBash: saved output as files, and file access as data

Date: 2026-11-13. Status: design agreed in conversation with the owner. Revised the same day after review; "What changed in the revision" at the end lists the differences from the first version. Five decisions are listed under "Owner decisions". Four are made; the first, which agents stop offering the spill tools, has a recommendation.

## Background

### What safeBash is for

Models are trained on shell commands, and for coding work they reach for `grep`, `cat`, `sed -n` and `tail` before any tool we hand them. A plain `bash` tool raises one effect, `std::bash`, whose payload is a string that could do anything, so no policy can approve it ahead of time. `safeBash` (`stdlib/safeBash.agency`) parses the command, works out what it does, and raises a narrower effect when it can: `cat a.txt` raises the same `std::read` the `read` tool raises. A user who has approved reads under the project folder is then never asked about `cat`. The dev doc is `docs/dev/stdlib/safe-bash.md`; read it in full before changing anything here.

### What safeBash already knows

- `READ_VERBS` is a table of the verbs that read the files they name: `cat`, `head`, `tail`, `wc`, `diff`, `cmp`, `sort`, `uniq`, `cut`, `nl`, `tac`, `rev`. `grep`, `ls`, `tree`, `du`, `find`, `rm`, `rmdir`, and redirects each have a rule of the same kind.
- A lone `cat`, `head`, `tail` or `grep` whose flags translate exactly runs in process, with no shell, through `_read` and `_grep`. A chain of such commands joined by `;`, `&&` or `||` also runs in process.
- Every other recognized line, a pipeline included, runs in real bash as text safeBash rebuilds, after raising the narrow effects for what it reads and writes.

### Why saved output should look like a file

When a tool result is too long, Agency saves it in the run (`docs/dev/stdlib/spill.md`) and tells the model to call `readSpill` or `grepSpill`. Pi, the agent we compare against on SWE-bench, writes long output to a temp file and names the path. The model then does what it always does with a file: `tail -50 /tmp/x.log`, `grep -n Error /tmp/x.log | head`, `sed -n '100,200p' /tmp/x.log`. The owner's view is that a file path is a more familiar pattern for a model than two special tools, and that every tool definition costs tokens on every request.

### Why the store stays the source of truth

The store in the run's globals survives pause and resume and needs no approval. A file on disk does neither. So the saved text stays in the store, and a file is only a copy of it.

The first version of this design had no file at all. A saved output was a path that only safeBash's in-process commands could read, and every other program was refused. That made the path a file for four commands and a refusal for the rest, and it needed a new in-process pipeline runner with twelve reimplemented text programs to make the gap smaller. This version writes a real copy at the moment a real program needs one, so every program works and none of that is needed.

## Goals

- The model reads saved output by path, with any command: `cat`, `tail`, `sed -n`, `wc -l`, a pipeline, a Python script.
- A line that only reads never asks for approval for the saved output it reads: `read`, `cat`, `head`, `tail`, `grep`, `wc`, and pipelines of the read verbs. A program with no rule, such as `sed`, `awk` or `python`, asks its own question as it does for any file.
- The store stays the only source of truth. A copy on disk can be deleted or changed at any time with no effect on what the next command reads.
- Agents that carry a shell no longer need to offer `readSpill` and `grepSpill`. The two functions stay in the stdlib for anyone who wants them.
- A plan can say which files its line touches, as data, for tests and policy helpers.

## Not goals

- No sandbox, and no change to how an opaque program is approved.
- No in-process pipeline runner. That is ADI-261, and this work does not need it. A pipeline keeps running in bash as it does today.
- No change to the host's file layer (`lib/host/`), beyond one small fact about the user (see "The folder").
- No writing into the saved-output folder through safeBash's own rules.
- No public API for a program to add its own virtual files. See "Later uses".

## Design

### The path

A saved output named `2026-11-13T04-05-06-123Z-a1b2c3.log` is shown to the model as a real path in the temp folder:

```
<temp folder>/agency-spill-<user id>/2026-11-13T04-05-06-123Z-a1b2c3.log
```

On Linux that is `/tmp/agency-spill-1000/…`. On a Mac the temp folder is a per-user folder under `/var/folders/`.

This was decided against two other spellings:

- `/agency/spill/<name>` cannot collide with a real file, but an ordinary user cannot create a folder at the root, so a copy could never be written there. Using it would mean rewriting the path inside the command text before bash runs, and a program's error messages would then show a second path the model never saw.
- A folder under the user's home is what OpenCode and Claude Code use. They use it because the file is their only copy and must be kept. Ours is a copy that can be rewritten at any time, so nothing needs to be kept, and files in the home folder are never cleaned up by the system.

### Recognizing a saved output

A saved-output name has a strict shape, which `isOutputName` in `lib/runtime/toolOutputStore.ts` already checks: letters, digits, `_` and `-`, ending `.log`. Names are unique. So a path is a saved output when its last two parts are an `agency-spill-<id>` folder and a name of that shape, whatever comes before:

```
/var/folders/ab/xyz/T/agency-spill-501/2026-11-13-a1b2c3.log   (written on a Mac)
/tmp/agency-spill-1000/2026-11-13-a1b2c3.log                   (written on Linux)
```

Both give the name `2026-11-13-a1b2c3.log`. One function answers this, and it is the only place that knows the shape:

```ts
/** The saved-output name a path points at, and the folder part before it, or null. */
export function spillPathParts(path: string): { folder: string; name: string } | null
```

It matches a whole path only. `…/agency-spill-501/x.log/../../etc/passwd` is not a saved output; it is an ordinary path and gets the ordinary rules.

Nothing is remembered about which folders a run has used. A path written on another machine is recognized by its shape alone.

### Three ways a saved output is read

**1. A command safeBash runs in process.** A lone `cat`, `head`, `tail` or `grep` of a saved-output path, or a chain of them, reads the text from the store by name. It does not look at the folder part and does not touch the disk.

No verb's rule knows about saved output. The path resolvers answer with where the bytes are, and one function reads them:

```
/** Where a resolved path's bytes are. */
export type ReadSource =
  | { kind: "disk"; dir: string; filename: string }
  | { kind: "saved"; folder: string; name: string }

/** The text a source holds. The only place that chooses between the disk and the store. */
def textOf(source: ReadSource): Result<string>
```

The read verbs and input redirects resolve their paths through `resolveReadPath`. grep resolves its path through `resolveTarget`, because a grep target can be a folder and `resolveReadPath` refuses one. Both ask `spillPathParts` before they stat anything, because the copy may not exist yet, through one small function they share. A new read verb gets saved output for free, because it resolves its paths the same way.

A `saved` source carries the folder as the command wrote it, so a rule can build its `std::read` or `std::grep` effect for the copy's path: `dir` is the folder and `filename` (or `file`) is the name. That effect is what `savedOutputRules` drops or keeps (see "No approval for reading saved output"). `textOf` ignores the folder and reads the store by name, so no executor can read a saved source from the disk.

**2. A line that goes to a real shell.** Right before the shell starts, one function writes the copies the line needs:

```ts
async function prepareSpillFiles(run: Run, paths: SavedPath[]): Promise<Result<void>> {
  const here = spillFolder(run.ctx.host);
  for (const { folder, name } of paths) {
    const text = findOutput(run, name);
    if (text === null) {
      return failure(missingOutputMessage(name));
    }
    if (folder !== here) {
      return failure(`Saved output ${name} is at ${here}${name} on this machine.`);
    }
    const written = await writeCopy(run.ctx.host, here, name, text);
    if (isFailure(written)) {
      return written;
    }
  }
  return success();
}
```

`findOutput` and `missingOutputMessage` exist today. A copy that cannot be written fails the line; the shell never runs on a missing file.

This also fails a line that only mentions a saved output whose name has left the store, such as `git log -- /tmp/agency-spill-1000/old.log`. That is intended. A model that names an old path is usually about to read it, and the failure tells it the output is gone. Do not add a special case for it.

**The plan decides once which paths are saved outputs.** `Plan` gains one field, `savedPaths: SavedPath[]`, where a `SavedPath` is the `{ folder, name }` that `spillPathParts` returns. `planFor` fills it:

- For a line that parses, from the parsed words: every word of every command that is a saved-output path, whatever the command. This is what the shell will see after it has removed quotes and escapes, so `cat /tmp/agency-spill-1000/'x'.log` is found.
- For a line that does not parse, from `spillPathsIn(text)`, a scan of the raw text. Such a line asks the broad `std::bash` question, so nothing on it is free.

Everything after reads that field. The rule that leaves out a read question and the function that writes the copies work from the same list, so they cannot disagree about a path.

**One function starts a shell.** safeBash starts a real shell in two places today: `runBash` calls `_bash`, and `startJob` calls `_startJob`. Both change to go through one function that calls `prepareSpillFiles(run, plan.savedPaths)` first and returns its failure. After the change, `_bash(` and `_startJob(` each appear once in the file, inside that function.

**3. The `read` tool.** The stdlib's `read` (`stdlib/index.agency`) checks for a saved output before anything else, and returns the stored text for one, with its usual `offset` and `limit` and no interrupt:

```
const saved = _savedOutputAt(dir, filename)
if (saved != null) {
  return _readSpill(saved, offset, limit)
}
// today's body: raise std::read, then read the file
```

`_savedOutputAt(dir, filename)` returns the saved-output name the two arguments point at, or null. It covers both ways a model can pass the path: the whole path as `filename`, or the folder as `dir`. It lives in `lib/stdlib/spill.ts` beside `_readSpill`.

Every `read` then works on these paths: `readCapped` in the coding bundle, the plain `read.partial(useAgentCwd: true)` the verifier gets, and a `read` in an agent a user builds. No bundle has a wrapper to remember.

This branch never touches the disk. It reads the store by name, as `readSpill` does today with no question, so a mistake in the check could return the wrong text but could not read a file without asking.

`index.agency` imports the two functions straight from `agency-lang/stdlib-lib/spill.js`, the way it imports its other TypeScript helpers. It does not import `std::spill`. `index.agency` is the prelude every stdlib module gets, `spill.agency` included, so an import of `std::spill` from it would be a cycle.

### No approval for reading saved output

Saved output is text the conversation was already handed a name for, which is why `readSpill` raises nothing today (`spill.md`, "No effects"). The same holds for reading it by path.

This is decided in one place. The rules build their effects as they do today, from the path the resolver gave them. Then, as the last step of `planFor`, after `bashPlan` and every other plan builder has run, the finished plan's effects pass through one function:

```
/** The saved-output rules, applied to a plan's effects: a read or a search of
  a saved output asks nothing, and anything else that targets the
  saved-output folder is refused. */
def savedOutputRules(effects: Effect[], savedPaths: SavedPath[]): Result<Effect[]>
```

It uses `accessesOf` (see "File accesses as data") to see what each effect touches:

- A `write`, `remove`, `list` or `find` access inside a saved-output folder fails the plan (see the next section).
- **When the line only reads**, a `read` or `search` access of a path in `savedPaths` is dropped. "Only reads" means every effect of the plan is `std::read`, `std::grep`, `std::ls` or `std::glob`. So `cat <saved output>` in process, and `wc -l <saved output>` and `grep -c x <saved output> | head` in bash, ask nothing.
- **When the line does anything else**, every effect is kept. In `ln -sf a <saved output>; cat <saved output>` the `cat` keeps its `std::read` for the copy's path.

`savedOutputRules` only drops or keeps effects; it never adds one. A program with no rule, such as `python parse.py <saved output>` or `sed -n '2,3p' <saved output>`, asks `std::exec` and nothing more, as it does for a file on disk. An approved `sed` can read any file under that same approval, so a `std::read` for the copy would protect nothing.

No verb's rule has a branch for saved output, and a verb added later is covered without a change.

**Why a line must only read.** The copies are written once, before the whole line runs. A command earlier in the same line could change a copy before a later command reads it:

```
ln -sf ~/.ssh/id_rsa /tmp/agency-spill-1000/x.log; cat /tmp/agency-spill-1000/x.log
```

`ln` asks `std::exec`. If the `cat` were free, approving the link would also read the key, with no read question asked. With the rule above this line keeps its `std::read`. A line whose every effect is a read has no command that can change a copy.

**The rule that makes this safe:** a read is free only when the bytes the command reads are the store's. In process that is true because `textOf` reads a `saved` source from the store. In a shell it is true because of three things together: the line only reads; `prepareSpillFiles` rewrites each copy from the store just before the shell starts, and fails the line when the folder is not this machine's; and the folder belongs to this user alone (see "The folder"). Say this in the comment on `savedOutputRules`.

A background job started by an earlier line could change a copy in the moment between the write and the read. That job was approved, under `std::bash` or `std::exec`, for a command that names the folder. This is accepted, and the dev doc says so.

**A shell line with no effects.** `bashPlan` turns an empty effect list into the broad `std::bash` question, so that "a log of effects is a complete audit of shell invocations", and `runBash`'s comment relies on it. `bashPlan` does not change. For `wc -l <saved output>` the `wc` rule builds one `std::read`, so `bashPlan` leaves the list alone, and then `savedOutputRules` drops it. A line whose rules built no effects at all, such as `echo <saved path>`, still gets `std::bash` from `bashPlan`, and `savedOutputRules` keeps it because it is not a read. So a shell plan ends with no effects only when `savedOutputRules` dropped at least one read of a saved output. See owner decision 3.

A path that only looks similar gets nothing free. `/etc/x/agency-spill-501/<name>` has the right shape, so it is recognized, and then:

- in process it reads the store's text for that name, which is harmless;
- on the bash path its folder is not this machine's folder, so the line fails before bash runs.

### The saved-output folder is read-only through safeBash

A redirect into the folder, an `rm` or `rmdir` of a path in it, and an `ls`, `tree`, `du` or `find` of the folder itself are refused at plan time, with a message that says the folder holds saved output and names what works. A listing is refused because the folder holds only the copies written so far, and the model would read that as the list of saved outputs.

The redirect, `rm` and listing rules do not each check for the folder. `savedOutputRules` refuses by the access's mode, so the check is written once and covers every verb that raises a file effect.

These refusals need a second recognizer beside `spillPathParts`, because `ls /tmp/agency-spill-1000` names the folder with no file, and `echo x > /tmp/agency-spill-1000/notes.txt` names a file that is not a saved-output name. `inSpillFolder(path)` is true when the path is an `agency-spill-<id>` folder or anything below one. It uses the same prefix constant. It looks at the path's parts, not at its start, so a real spelling such as `/private/var/folders/…` on a Mac is recognized too.

An opaque program can still write to a copy. Across lines that changes nothing, because the copy is rewritten from the store before the next line that names it. Inside one line it is why a line that runs such a program keeps its read question.

### The folder

`spillFolder(host)` is `host.system.tempDir()` joined with `agency-spill-<user id>`, with a trailing separator. The text `agency-spill-` is one named constant, which the pattern and `spillFolder` both use.

- The user id is in the name because `/tmp` on Linux is shared. Without it, a second user on the machine could not create their folder. `HostSystem` has no user id today, so it gains one small fact, `userId(): string`. The Node host answers from `process.getuid()`, and with a fixed value on Windows, where that call does not exist and the temp folder is already per user. The browser and memory hosts answer with a fixed value.
- **The folder must belong to this user alone.** On Linux another user can create `/tmp/agency-spill-1000` first, open to everyone. They could then swap a copy for a link to a private file after it is written and before the shell reads it, and the read would be free. So `writeCopy` checks the folder every time, after it creates or finds it: it must be a real folder and not a link, owned by this user, with no access for anyone else (mode `0700`). If any of these fails, the line fails with a message and no shell starts. The message names the folder and says to remove it, or to run `chmod 700` on it when it is the user's own. `writeCopy` does not fix the mode itself: by then anyone with access has had the chance to plant a file. On a Mac the temp folder is already private to the user; the check runs there too.
- The host's `WriteOptions` has `fileMode` for the file and `makeFolders`, but no mode for a folder it makes. The folder is created by an explicit step with mode `0700`, not by `makeFolders`. If the host has no call for that, it gains one.
- `writeCopy` writes the file through the host's contained files (`host.files.root(...)`), the way `lib/stdlib/clipboard.ts` writes its temp file, with `fileMode` `0600`. That layer refuses a symlink below its root (`docs/dev/stdlib/contained-files.md`).
- **One spelling of the folder.** The check `folder !== here` compares text. On a Mac, `tempDir()` answers a path under `/var/folders/`, and its real path is under `/private/var/folders/`. `spillFolder`, the notices, and the check all use `host.system.tempDir()` as it is given, never a real path. `host.files.root()` resolves the real path, so nothing built from a root is compared with `here`.
- A copy is overwritten every time it is needed.
- Nothing deletes the folder. The system cleans the temp folder, and a copy that vanished is written again.

### A host with no disk

On the browser host nothing can be written, and no real program runs there either. `prepareSpillFiles` is only reached before `_bash` and `_startJob`, which that host does not have. In-process reads and the `read` tool work from the store as on any host.

### A run resumed on another machine

The temp folder differs between machines, so a run that moves from a Mac to a Linux server holds paths from the old one.

- In-process reads and `read` work, because they use only the name.
- A real program that names the old path gets the failure in `prepareSpillFiles`, which gives the path on this machine. The model retries with it. This is the single `if (folder !== here)`.

This is rare. A resume on the same machine, or in another container of the same image, has the same temp folder.

### The notices

Every notice names the path, and only the path. There is one wording, whoever writes it and whatever tools the model has:

```
[Showing lines 4012-6011 of 6011. The full output is saved as a file: /tmp/agency-spill-1000/2026-…-a1b2c3.log Command exited with code 0.]
```

```
[Output too long (148,210 characters). It is saved as a file: /tmp/agency-spill-1000/2026-…-a1b2c3.log]
```

The first is `tailNotice`, for a command's output. The second is `outputNotice`, which the tool loop writes for any other tool's long result, and keeps its preview of both ends. The path is followed by a space, so a model copies it without punctuation.

The notice names no tool and no command. What can read the path is said where each tool is described: in the `bash`, `safeBash`, `read`, `readSpill` and `grepSpill` descriptions.

### Every reader takes the path

Nothing asks which tools a model has. Each tool that can read saved output accepts the path in its own code:

- `read` (case 3 above) and `safeBash` (cases 1 and 2).
- `readSpill` and `grepSpill` take the path as well as the bare name. `readSpill(filename: "/tmp/agency-spill-1000/2026-…-a1b2c3.log")` reads the same text as `readSpill(filename: "2026-…-a1b2c3.log")`. This is one call to `spillPathParts` at the top of `_readSpill` and `_grepSpill`.

So `keepOutput` uses the same wording as everything else. `jobOutput` in `stdlib/jobs.agency` calls it, and the coordinator's main agent, which has `spillTools()` and no shell, reads a job's notice by passing the path to `readSpill`.

**`readSpill` and `grepSpill` are not removed.** They stay public functions in `std::spill`, and any program or agent can offer them. This work makes `read` and `safeBash` work on a saved output as well. The agents that carry a shell stop offering the two spill tools, because they no longer need them (owner decision 1).

### The tool loop stops asking about the tools

Today the loop looks at a call's tools for two reasons, both through a check that names `readSpill` and `grepSpill` (`isReader` in `lib/runtime/toolOutputStore.ts`):

1. To word its notice, with the names the model sees those two tools under (`spillReaders`).
2. To refuse a call that sets `spillToolResultsOver` with no `readSpill` in its tools (`spillSettings` in `lib/runtime/toolInvocation.ts`).

Both are removed. The notice names only the path, so there is nothing to look up. And the refusal goes: once `read` reads a saved output, nearly every tool list can, and the loop cannot know which lists can without naming tools.

The cost is the lost guard. A caller who turns saving on and offers nothing that can read a path gets a model that cannot follow the notice. That shows up the first time they run it, and `spillToolResultsOver`'s documentation says what the model needs.

One use of the check stays as it is: a result that `readSpill` or `grepSpill` returns is not saved a second time (`isSpillReader`).

The runtime ends up knowing less about tools than it does today. The alternatives were turned down for the opposite reason: a longer list of tool names in the runtime, a marker that needed language work, or an option on `llm()`.

### Known gaps

- **`exec`.** `shellTools()` also hands out `exec`. `exec("wc", ["-l", "<saved output>"])` does not go through safeBash, so no copy is written and the program fails with "No such file". It asks `std::exec`, so nothing is read without a question; the model loses a round.
- **`sed -n`.** It is the usual way a model takes a slice of a file, and it has no rule in safeBash, so it asks `std::exec`. A read rule for `sed -n 'A,Bp'` would make it free. That is a separate piece of work.

### Reading a saved output does not save it again

`cat <saved output>` in process returns the text through `keepOutput`, and a long `read` result goes through the tool loop's own saving. Either would store the same text a second time under a new name. The store holds at most 1,000,000 characters and drops its oldest entries to make room, so a second copy of a large output would push out the first one and everything saved before it.

`storeOutput` returns the name of an entry that already holds the same text, and stores nothing. This is one comparison in one place. It covers `cat`, `read`, and any later reader, and the runtime learns nothing about tools.

### File accesses as data

The file effects already carry their paths: `std::read` has `dir` and `filename`, `std::grep` has `dir` and `file`, `std::write` has `dir` and `filename`, `std::remove` has `target`, `std::ls` has `dir`, and `std::glob` has `dir` and `pattern`. So "which files does this line touch" can be read back out of a plan's effects, and no rule has to change.

```
export type FileAccess = {
  mode: "read" | "search" | "list" | "find" | "write" | "remove";
  path: string
}

/** The file accesses among a plan's effects, in order. */
export def accessesOf(effects: Effect[]): FileAccess[]

/** True when every effect of the plan is a file access. */
export def onlyTouchesFiles(plan: Plan): boolean
```

Rules:

- **Derived, never recorded.** There is no `accesses` field on `Plan` to keep in step with `effects`. `accessesOf` is a projection.
- **Accesses cover file effects only.** `git checkout -- a.txt` overwrites a file and is not a file access; its effect is `std::git::checkout`. A caller that asks "does this plan only read under this folder?" must also call `onlyTouchesFiles`. The doc says so next to `accessesOf`.
- **Six arms and a default.** `accessesOf` matches the six file effects and answers nothing for any other. It does not list the git and gh effects one by one. A file effect added later and forgotten here errs in the safe direction: `onlyTouchesFiles` answers false for it.
- **Saved-output reads are not in a finished plan's list.** `savedOutputRules` has dropped their effects by then. `planRecord`, which feeds the `safeBash plan` debug event, gains the accesses and, separately, the saved-output names the line reads.

This part is small, and `savedOutputRules` is its first user, so it is built first.

## Later uses

Other things an agent could read as a file under the same pattern, each with its own folder name and its own function that returns the text for a name:

- the output of a background job (`std::jobs`), so the model can `tail` a running job;
- the part of a conversation that compaction summarized away;
- a subagent's full report, so the coordinator gets a path and not the whole text.

When the second one is built, `spillPathParts` and `prepareSpillFiles` become a small table: a folder name and a reader per row. Do not build the table now, with one row. And do not expose it to user programs until a second internal use has shown what the row needs.

## Owner decisions

**Owner decision 1: which agents lose the spill tools.** Recommendation: the bundles that carry `bash` or `safeBash`. An agent that fetches pages and has no shell keeps `spillTools()`, because it has nothing to read a path with.

**Owner decision 2: whether `readSpill` and `grepSpill` stay in the stdlib. Decided: yes.** They stay public, and they also accept the path.

**Owner decision 3: a shell line that reads only saved output. Decided.** safeBash had a stated rule that every shell start raises at least one effect, and `wc -l <saved output>` has none left. The rule becomes: every shell start raises an effect, or `savedOutputRules` dropped at least one read of a saved output from a line that only reads. `bashPlan` itself does not change. The comments in `bashPlan` and `runBash` change to state the new rule, and the `safeBash plan` debug event still records the line.

**Owner decision 4: whether the stdlib's `read` reads a saved output. Decided: yes.** See "Three ways a saved output is read", case 3. The alternative was a wrapper in the agents library that each bundle had to use.

**Owner decision 5: how the tool loop learns that a tool list can read a path. Decided: it does not.** See "The tool loop stops asking about the tools". The notice names only the path, each reader accepts the path, and the refusal for a call with no reader is removed.

## What it costs

| Part | Source lines | Test lines | Risk |
|---|---|---|---|
| 1. File accesses from effects | about +60 | about +80 | Low. Two pure functions. |
| 2. Saved output as files | about +400 | about +400 | Medium. It leaves out an approval question, so the rule in "No approval for reading saved output" has to hold on every way a shell starts. |
| 3. Notices and agents | about +100, and about −80 in the runtime | about +150 | Medium. It changes what every agent with a shell sees. |

About 560 lines of source added and 80 removed, and 630 of tests. The first version of this design was estimated at about 1,500 and 1,000.

## How we will know it worked

- Part 1: no existing safeBash test changes its expected output.
- Part 2: every existing safeBash test passes unchanged, and the new tests in the plan pass.
- Part 3: a run of the coding agent on the 100-task SWE-bench set (`~/bench-agency`), this build against `main` at the same time, comparing pass count, model calls, input tokens, and how often the model reads saved output and by which command. The owner approves benchmark spend separately.

## Things that are easy to get wrong

- **Every way a shell starts.** `prepareSpillFiles` must run before each one, and there are two: `_bash` and `_startJob`. A path that skips it sends a line to a shell that names a file which may not exist, and for a read verb it does so with the approval question already left out. This is why both calls live in one function.
- **The plan decides once.** Nothing after `planFor` looks at path text to ask whether it is a saved output. The in-process executors read the `ReadSource` the resolver gave them, and the shell path reads `plan.savedPaths`.
- **A `find` access names the folder searched,** not the files found. `std::glob` carries a folder and a pattern, and `accessesOf` keeps the folder.
- **Whole paths only.** `spillPathParts` must not match a prefix of a longer path. Leaving out an effect for `…/x.log/../../etc/passwd` would be an unapproved read.
- **Plan-time resolution.** Every read is resolved when the plan is made (`safe-bash.md`, "Resolving the path when the plan is made"). A saved-output path is the exception: it is not statted, and a name evicted between the plan and the run gives the store's "no longer available" failure, not a crash.
- **Handlers.** safeBash's executors call `_read` and `_grep`, not `read` and `grep`, because `raiseAll` already raised the effects (`safe-bash.md`, "Why the executors call `_bash`, `_write`, `_grep`, and `_read`"). The store read follows the same rule, and a plan whose effect list is empty must still go through `raiseAll`.
- **The refuse wall still sees every command.** A line that names a saved output has been through the wall like any other.
- **Checkpoints.** `prepareSpillFiles` writes a file as a side effect. A resume that re-runs the step writes the same bytes again, which is harmless. Do not store the folder in the run's state.

## What changed in the revision

- A real copy is written on demand. The first version had no file on disk and refused any program safeBash does not run itself.
- The in-process pipeline runner (the old Part 3) and the measurement that sized it (the old Part 0) are gone.
- The mount table is gone. One function recognizes a saved-output path by its shape. "Later uses" says when a table is worth building.
- File accesses are derived from effects. The first version added an `accesses` field to `Plan` and changed every rule to fill it.
- The path is a real path in the temp folder. The first version recommended `/tmp/agency-spill/<name>` as a spelling for a file that did not exist.
- This work builds on PR #1472 (`tailNotice`, `exitIsFailure`, `modelSafeBash`), which merged to `main` at `a80b90157`.

A second review (`docs/superpowers/plans/2026-11-13-safebash-file-access-review-2.md`) then found the cases the free read did not cover. From it: a line must only read for its saved-output reads to be free; the folder must belong to this user alone; the plan decides once which paths are saved outputs; `startJob` starts a shell too; and owner decisions 3 to 5.

The owner then settled those three: a shell line that reads only saved output raises nothing; the stdlib's `read` reads a saved output itself; and the tool loop stops looking at a call's tools, with one notice wording that names only the path and every reader accepting the path.

A third review (`2026-11-13-safebash-file-access-review-3.md`) led to: `savedOutputRules` runs last and `bashPlan` does not change; a `saved` source carries its folder, so a mixed line's read question has a path; grep's resolver is `resolveTarget`; a second recognizer, `inSpillFolder`, for the folder refusals; `storeOutput` does not store the same text twice; and opaque programs ask only `std::exec`.
