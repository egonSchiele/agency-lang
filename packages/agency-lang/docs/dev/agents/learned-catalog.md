# The learned catalog

`agency agent` keeps two kinds of thing a user teaches it across
sessions: skills, which are Markdown notes a subagent reads on demand,
and tools, which are small Agency programs a subagent can call. They
live under the agent home, `~/.agency-agent` or `AGENCY_AGENT_HOME`:

- `<agent-home>/skills/<name>.md`: flat-layout skills, written by
  `std::skills` (`designSkill` and `writeSkill`).
- `<agent-home>/tools/<name>/`: toolbox entries, written by
  `std::toolbox` (`designTool` and `writeTool`).

`lib/agents/agency-agent/lib/learned.agency` owns everything about
them: where they live, the catalog scanned from them, the LLM tools
built from the catalog (one `learned_skills` tool listing every skill,
and one `learned_<name>` tool per saved tool), and the two save
operations, `designLearnedSkill` and `designLearnedTool`. Nothing
outside the module knows the directories or that the catalog is a
cache.

## One catalog, every subagent

There is one skills directory and one tools directory, not one per
subagent. `learnedExtras()` is the list every subagent adds to its own
tools.

## When it is scanned

The catalog is built on first use and kept for the session. It is
thrown away and rebuilt in two cases:

- After a save. `designLearnedSkill` and `designLearnedTool` drop the
  catalog once the stdlib reports the file is on disk. The catalog is
  never patched in place. A cached record could drift from what a scan
  sees, and a scan is cheap.
- After a session restore. A resumed session brings back every `let`
  global from the checkpoint, the catalog included, as it was when the
  session was saved. Nothing after the restore runs and `init` is a
  completed step the replay skips, so there is no hook to clear it.
  Instead the catalog records `PROCESS_TOKEN`, a `static` made once per
  process. Statics are not part of a checkpoint, so the resumed process
  has a new token, the restored catalog has the old one, and the first
  use rebuilds it. A process id would not do. Ids are reused, and a
  resume that happened to land on the same id would keep a stale
  catalog without a trace.

  The token cannot tell an in-process `restore()` apart. That rolls the
  catalog back inside the same process, and the tokens match. The only
  `restore` in the agent is the session resume in `lib/resume.agency`,
  which runs before the catalog is ever built. Whoever adds another
  restore should call `invalidateLearned()` after it, or accept a
  catalog as old as the checkpoint.

A root that does not exist is skipped without a prompt. A scan that
fails is cached as empty, whether the user rejected it or the directory
could not be read, so a user who said no is not asked again that
session. The cost is that a broken skills directory is silent until the
user looks for a skill they expected. A prompt or a message on every
subagent dispatch would be worse.

The LLM tools are built fresh from the cached entries on every call.
The tool objects are never held in a global. Entries are plain data a
checkpoint can carry. Partially applied tools are not.

Each scan raises one interrupt per root: `std::skills::skillsDir` for
the skills and `std::toolbox::scan` for the tools. Both are approved
under `<agent-home>` by the `recommended` policy, so scanning never
prompts there.

## Names

A learned tool is offered as `learned_<name>`. No built-in tool uses
that prefix (`toolWiring.agency` pins this), so a learned tool cannot
shadow one. Providers cap a tool name at 64 characters
(`MAX_TOOL_NAME_LEN`, declared once in `std::skills` and imported by
`std::toolbox`), so a learned tool's own name is capped at 56
(`maxLearnedToolName()`). `designLearnedTool` refuses a longer name
before any prompt. A tool dropped into the directory by hand with a
longer name, or one `listTools` reports as broken, stays in the catalog
and is not offered. One bad name fails every LLM call that lists it.

## The coordinator's tools

`lib/agents/agency-agent/brains/coordinator/learn.agency` holds
`learnSkill(goal, name?, description?)` and
`writeToolFor(purpose, name?, request?)`. Each makes at most one model
call to draft what the caller left out (the skill body is always
drafted), checks the reply against the proposal type, calls the
catalog's save operation, and phrases the reply. The save operation
runs the stdlib loop: `designSkill` shows the user the whole file and
redrafts on feedback; `designTool` has a coding agent write the
implementation, tests it, and shows it. Both end in the stdlib's save
gate. Nothing here adds a handler or a policy rule.

Under the `recommended` policy a save prompts more than twice, because
`std::mkdir` and `std::write` under the agent home have no rule. A
skill takes the review, the save gate, a `mkdir`, and a `write`. A tool
takes a `mkdir` for its staging directory before any draft exists, the
coding agent's reads and writes in it, the review, and the save gate.

In a one-shot run (`-p`, piped stdin) the policy handler rejects every
undecided effect, the review gate included. The coordinator tells
`learn.agency` the run is one-shot (`setLearnOneShot`, set from
`coordinatorInit` next to `setCodeOneShot`), and both tools reply that
nothing can be saved before spending a model call on a draft.

## Files and tests

- `lib/agents/agency-agent/lib/learned.agency`: the catalog.
- `lib/agents/agency-agent/tests/learned.agency`: the one-scan-per-root
  property, invalidation, the process token, missing roots, a rejected
  scan, and the tool names, over `tests/learned-fixture/`. The fixture
  tool has no `tool.agency`, so it lists but cannot run.
- `lib/agents/agency-agent/brains/coordinator/learn.agency`: the tools.
- `lib/agents/agency-agent/brains/coordinator/tests/learn.agency`: the
  one-shot refusal, an accepted save reaching the catalog, a rejected
  review, a rejected tool staging directory, a malformed draft, and the
  name cap. Run it with `AGENCY_USE_TEST_LLM_PROVIDER=1`, or the drafts
  go to a real model.
- `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency`:
  no built-in tool uses the `learned_` prefix, and the coordinator's
  list has unique names with the two tools in it.
- `stdlib/skills.agency`: `listSkills`, the scan behind both
  `skillsDir` and the catalog; `tests/agency/skills-list.agency` covers
  it and `tests/agency/skills-dir.agency` covers `skillsDir` on top of
  it.

Not yet done: handing `learnedExtras()` to each subagent, the `/skills`
and `/toolbox` commands, and an eval that teaches a skill, restarts, and
uses it.
