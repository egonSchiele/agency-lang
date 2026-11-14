# safeBash: file access as data, pipelines in process, and saved output as files

Date: 2026-11-13. Status: design agreed in conversation with the owner; three decisions are marked **Owner decision** below and have a recommendation.

## Background

### What safeBash is for

Models are trained on shell commands, and for coding work they reach for `grep`, `cat`, `sed -n` and `tail` before any tool we hand them. A plain `bash` tool raises one effect, `std::bash`, whose payload is a string that could do anything, so no policy can approve it ahead of time. `safeBash` (`stdlib/safeBash.agency`) parses the command, works out what it does, and raises a narrower effect when it can: `cat a.txt` raises the same `std::read` the `read` tool raises. A user who has approved reads under the project folder is then never asked about `cat`. The dev doc is `docs/dev/stdlib/safe-bash.md`; read it in full before changing anything here.

The owner's goal for this work is narrow: **fewer prompts for commands that read and search**, and a way to give the model saved output as something that looks like a file. It is not a goal to make opaque programs (`pytest`, `python x.py`, `make`) safe to approve ahead of time, and no sandbox is part of this design.

### What safeBash already knows

It already knows which commands read files. This matters because the work is smaller than it first looks.

- `READ_VERBS` is a table of the verbs that read the files they name: `cat`, `head`, `tail`, `wc`, `diff`, `cmp`, `sort`, `uniq`, `cut`, `nl`, `tac`, `rev`. From a row, `readFileVerb` answers a `FileRead`: the paths the command reads, or "stdin" when it names none.
- `grep`, `ls`, `tree`, `du`, `find`, `rm`, `rmdir`, and redirects each have a rule of the same kind.
- A lone `cat`, `head`, `tail` or `grep` whose flags translate exactly runs in process, with no shell, through `_read` and `_grep` (`tryShellFreeRead`, `tryShellFreeGrep`). A chain of such commands joined by `;`, `&&` or `||` also runs in process (`tryShellFreeChain`, `runChain`).

### What is missing

Three things, and each is one part of this design.

1. **"What does this line touch" is not a value.** Each rule goes from the command straight to an effect to raise. Nothing in a `Plan` says "this line reads these two paths" as plain data that a test, a policy check, or another feature could use.
2. **A path must be a real file on disk.** `resolveReadPath` calls `_searchTargetIn`, which resolves the real path and stats it. A path that names something held in the run's memory cannot pass.
3. **A pipeline always goes to real bash.** `grep -n FAILED out.log | tail -5` is recognized (every stage has a rule) but it runs as rebuilt text in a real shell. The dev doc says so and names the missing piece: "a pipeline needs a runner of its own (ADI-261)". A real shell cannot see a file that exists only in the run's memory.

### Why saved output should look like a file

When a tool result is too long, Agency saves it in the run (`docs/dev/stdlib/spill.md`) and tells the model to call `readSpill` or `grepSpill`. Pi, the agent we compare against on SWE-bench, writes long output to a temp file and names the path. The model then does what it always does with a file: `tail -50 /tmp/x.log`, `grep -n Error /tmp/x.log | head`. The owner's view is that a file path is a more familiar pattern for a model than two special tools, and that every tool definition costs tokens on every request.

The owner does not want saved output written to the real disk. The store in the run's globals survives pause and resume and needs no approval; a file on disk does neither. So the plan is a path that looks like a file, resolves to the stored text, and works with the commands safeBash runs itself.

## Goals

- A `Plan` carries the file accesses its line makes, as data. Effects are derived from them.
- A table of mounts says which paths are not on disk and how to read them. Saved output is the first mount, and adding another is one row.
- A pipeline whose every stage safeBash can run itself runs in process.
- The model reads saved output with `cat`, `head`, `tail`, `grep`, pipelines of those, and the `read` tool. The agents no longer carry `readSpill` and `grepSpill`.

## Not goals

- No sandbox, and no change to how an opaque program is approved.
- No virtual files for programs safeBash does not run itself. `python parse.py <saved output>` cannot work, and the design says what the model sees instead.
- No change to the host's file layer (`lib/host/`). Mounts are known to safeBash and to the agents' `read` tool, not to every file operation.
- No writing into a mount.

## Words

This spec says **file access**, not "capability". `@capabilities(fileRead)` already means "what the host platform allows this function to do" (`docs/dev/language/capabilities.md`). Using the same word for "what a command line touches" would give one word two meanings in the same file.

## Design

### Part 1: file access as data

Two new types in `stdlib/safeBash/actions.agency`:

```
/** Where a path's bytes live. */
export type Place = { kind: "disk" } | { kind: "store"; name: string }

/** One thing a command line does to one path. */
export type FileAccess = {
  mode: "read" | "search" | "list" | "write" | "remove";
  dir: string;
  filename: string;
  place: Place
}
```

`Plan` gains `accesses: FileAccess[]`. The rules that today build a `std::read`, `std::grep`, `std::ls`, `std::write` or `std::remove` effect directly build a `FileAccess` first, and one function turns an access into its effect:

```
def effectFor(access: FileAccess): Effect | null {
  return match(access) {
    { place: { kind: "store" } } => null
    { mode: "read" }   => readEffect(...)
    { mode: "search" } => grepEffect(...)
    { mode: "list" }   => lsEffect(...)
    { mode: "write" }  => writeEffect(...)
    { mode: "remove" } => removeEffect(...)
  }
}
```

**Rule: for a path on disk, the effects a line raises do not change.** Part 1 is a refactor. Every existing case in `tests/agency/safeBash.agency` must pass unchanged, and that is the test of this part.

Some effects carry more than a path (a grep's pattern and flags, a write's bytes and mode). The access holds the path facts; the effect builder still receives the rest from the rule. Where carrying everything through `FileAccess` would bend the type, keep the effect built by the rule and record the access beside it. The requirement is that `plan.accesses` is complete and truthful, not that every effect is built in one function.

Effects that are not file accesses (`std::exec`, `std::bash`, the git and gh effects) are untouched.

What this buys at once: a test or a policy helper can ask "does this plan only read, and only under this folder?" without parsing effect payloads. `planRecord`, which feeds the `safeBash plan` debug event, should include the accesses.

### Part 2: mounts

```
type Mount = { prefix: string; place: (rest: string) => Result<Place> }

static const MOUNTS: Mount[] = [
  { prefix: SPILL_MOUNT, place: spillPlace }
]

/** The mount that owns a literal path, or null. */
def mountFor(text: string): Mount | null
```

`resolveReadPath` and the grep path resolver ask `mountFor` before they touch the disk. A mounted path resolves to a `ReadPath` whose place is not disk; it is never statted. The executors read through the place:

```
def bytesOf(access: FileAccess): Result<string> {
  return match(access.place) {
    { kind: "disk" }        => try _read(access.dir, access.filename)
    { kind: "store", name } => readSpill(name)
  }
}
```

Rules:

- **A store access raises no effect.** Saved output is text the conversation was already handed a name for, which is why `readSpill` raises nothing today (`spill.md`, "No effects").
- **A mount is read-only.** A write, a redirect, an `rm`, or a listing that names a mounted path is refused at plan time with a message.
- **A mounted path with `..` or a second component is refused.** A mount holds flat names. `spillPlace` accepts only what `isOutputName` accepts.
- **A missing name is a failure with the store's own message**: "Saved output … is no longer available. Call the tool again if you need it."
- **A line that names a mounted path and cannot run in process is refused**, with a message that teaches:

  ```
  /tmp/agency-spill/2026-…-a1b2c3.log is saved output, not a file on disk, so `python` cannot open it.
  Read it with cat, head, tail, or grep, or a pipeline of those.
  ```

  Without this rule the line would go to bash and fail with "No such file or directory". The check must cover an unparseable string too, by looking for the mount prefix in the raw text.

**Owner decision 1: how a mounted path is spelled.** Recommendation: `/tmp/agency-spill/<name>`. It is what a model expects a temp file to look like, and the folder name is ours. The cost is that a real folder of that name could not be reached through safeBash, which nobody will miss. The alternative is a spelling that cannot exist on disk, such as `spill:<name>`. That cannot collide, but a model has no habit for it, and the parser may not treat it as a path word.

### Part 3: pipelines in process

A pipeline runs in process when its first stage is something safeBash can already run itself and every later stage is a filter it can run itself.

- **Sources** (first stage): an `echo`, a `cat`/`head`/`tail` that translates, a `grep` that translates. These are today's step planners (`tryShellFreeStep`).
- **Filters** (later stages): a read verb with no path, or a `grep` with no path, or `tr`. These are the commands `stdinStage` already recognizes as "reads the pipe".

A new execution kind:

```
export type PipeExec = { kind: "pipe"; source: StepExec; filters: Filter[] }
```

`PipeExec` is added to `StepExec`, so a pipeline can be a link in a chain (`cat a.log | tail -3; echo done`). A parenthesized group still refuses, as it does for a chain.

Each filter is a pure function from text to text, written in TypeScript in a new `lib/stdlib/pipeFilters.ts`, one per verb, taking the flags its `READ_VERBS` row allows. The flag tables are the contract: a flag a row lists must be implemented, and nothing else is accepted. The filters, in the order they should be built (most used first; Part 0 of the plan measures this):

`head`, `tail`, `grep`, `wc`, `sort`, `uniq`, `cut`, `tr`, `nl`, `tac`, `rev`, `cat`.

Rules:

- **All or nothing, as everywhere in safeBash.** If any stage is not a source or filter that translates, the whole line takes today's path. `git log | head` and `pytest | tail -20` keep running in bash exactly as now.
- **Exit status is the last stage's**, as in bash without `pipefail`. A `grep` filter with no match fails with exit 1 and the text so far.
- **Output must match the real program** for every accepted flag, on GNU, BSD and busybox. Where the three differ for an accepted flag (for example `wc`'s column padding, or `sort`'s locale ordering), pick the behaviour under `LC_ALL=C` on GNU, and document the choice in the dev doc. A flag whose behaviour cannot be matched is taken out of the in-process path, not approximated.
- **`head` ends the pipeline early in bash** (the writer gets SIGPIPE). In process there is no writer to stop: the source has already produced its text. The visible result is the same.
- **Size.** The whole text of each stage is held in memory. A source is a file read, which the `read` tool already bounds; apply the same bound, and fail with a message when the source is larger.

What this buys beyond saved output: every `grep … | head` and `cat … | tail` on real files now runs with no shell, under the read and grep effects, with the same output on every machine.

### Part 4: saved output as files

- `outputNotice` and `tailNotice` (`lib/runtime/toolOutputStore.ts`) name the path, not the tools:

  ```
  [Showing lines 4012-6011 of 6011. Full output: /tmp/agency-spill/2026-…-a1b2c3.log]
  ```

- The agents' `read` tool (`readCapped` in `stdlib/agents/lib/toolkits.agency`) reads a mounted path from the store, with its usual `offset` and `limit`, and raises no interrupt for it. It asks the same `mountFor`, so there is one table. Put `MOUNTS` and `mountFor` where both can import them without a cycle; a small module of their own is likely.
- `codingFileAndShellTools()` drops `readSpill` and `grepSpill`. The tool loop refuses a call that sets `spillToolResultsOver` without offering a reader (`spillSettings` in `lib/runtime/toolInvocation.ts`); that check has to learn that a tool list with a mount-aware `read` or `bash` counts. **Do not** add a case for a tool name in the runtime. Give the function a marker the loop can read, as `spillReaders` reads the module and registered name today.

**Owner decision 2: which agents lose the spill tools.** Recommendation: only the bundles that carry `bash` (the coding bundle). An agent that fetches pages and has no shell keeps `spillTools()`, because it has nothing to read a path with.

**Owner decision 3: whether `readSpill` and `grepSpill` stay in the stdlib.** Recommendation: yes. They are public functions, programs use them, and the mount is built on them.

## What it costs

`stdlib/safeBash.agency` is 5,377 lines with 2,699 lines of tests. A rough estimate of what this adds:

| Part | Source lines | Test lines | Risk |
|---|---|---|---|
| 1. Accesses as data | about +250, with about 100 changed | few new; all existing must pass | Low. A refactor with a strong test suite behind it. |
| 2. Mounts | about +200 | about +200 | Low to medium. The refusal rule for lines that cannot run in process has to be airtight. |
| 3. Pipelines in process | about +400 Agency, about +500 TypeScript | about +700 | Medium to high. Matching real programs byte for byte is a long tail. |
| 4. Saved output as files | about +150 | about +150 | Medium. It changes what every coding agent sees. |

In total about 1,500 lines of source and 1,000 of tests, which grows safeBash by roughly a third. Most of the lasting complexity is in Part 3: twelve small text programs that must agree with coreutils. That code is pure and easy to test, but each flag added later is a new place to disagree with the real tool.

## How we will know it worked

- Part 1: no existing safeBash test changes its expected output.
- Part 3: for each filter and each accepted flag, a test that runs the in-process filter and the real program on the same input and compares the output. These need a shell, so mark them the way the existing real-git tests are marked.
- Part 4: a run of the coding agent on the 100-task SWE-bench set (`~/bench-agency`), this build against `main` at the same time, comparing pass count, model calls, and how often the model reads saved output and by which command. The owner approves benchmark spend separately.
- From the benchmark transcripts: the share of bash calls that run with no shell, before and after.

## Things that are easy to get wrong

- **Plan-time resolution.** Every read is resolved when the plan is made (`safe-bash.md`, "Resolving the path when the plan is made"). A pipeline source is resolved the same way. A mounted name evicted between the plan and the run gives the store's "no longer available" failure, not a crash.
- **The refuse wall still sees every stage.** `flattenOne` feeds it and must keep seeing through pipelines and groups. A pipeline that runs in process has still been through the wall.
- **Handlers.** safeBash's executors call `_read` and `_grep`, not `read` and `grep`, because `raiseAll` already raised the effects (`safe-bash.md`, "Why the executors call `_bash`, `_write`, `_grep`, and `_read`"). A new executor follows the same rule, and every path into it must run through `raiseAll`. A store access raises nothing by design; say so in a comment where the effect list can be empty.
- **`.partial` and the agent's `bash`.** The agents carry `safeBash.partial(cwd: "", exitIsFailure: false)`. A pipeline whose last filter is a no-match `grep` is a command exit, so it must carry `data.type == "commandExit"` to come back as a result, not a failed call.
