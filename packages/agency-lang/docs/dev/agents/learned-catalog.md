# The learned catalog

`agency agent` keeps two kinds of thing a user teaches it across
sessions: skills, which are Markdown notes an agent reads on demand,
and tools, which are small Agency programs an agent can call. They live
under the agent home, `~/.agency-agent` or `AGENCY_AGENT_HOME`:

- `<agent-home>/skills/<name>.md`: flat-layout skills, written by
  `std::skills` (`designSkill` and `writeSkill`).
- `<agent-home>/tools/<name>/`: toolbox entries, written by
  `std::toolbox` (`designTool` and `writeTool`).

`lib/agents/agency-agent/lib/learned.agency` owns everything about
them: the directories, the catalog scanned from them, the LLM tools
built from the catalog, and the two save operations,
`designLearnedSkill` and `designLearnedTool`. Nothing outside the
module knows the directories or that the catalog is a cache.

There is one skills directory and one tools directory shared by every
subagent. `learnedExtras()` is the list of LLM tools to add to an
agent's own: one `learned_skills` tool listing every skill, and one
`learned_<name>` tool per saved tool. Wiring it into each subagent's
dispatch is not done yet, so today a saved skill or tool sits in the
catalog until that lands.

## When the catalog is rebuilt

The catalog is scanned on first use and kept for the session. It is
thrown away and rebuilt in two cases:

- After a save. The catalog is never patched in place; a scan is cheap.
- After a session restore. A resumed session brings back every `let`
  global from the checkpoint, the catalog included. Nothing runs after
  the restore that could clear it, so the catalog records
  `PROCESS_TOKEN`, a `static` made once per process. Statics are not
  part of a checkpoint, so the resumed process has a new token, the
  restored catalog has the old one, and the first use rebuilds it. A
  process id would not do, because ids are reused.

  The token cannot tell an in-process `restore()` apart, because the
  tokens match. The only `restore` in the agent is the session resume
  in `lib/resume.agency`, which runs before the catalog is ever built.
  Whoever adds another restore should call `invalidateLearned()` after
  it.

A root that does not exist is skipped without a prompt. A scan that
fails, a rejected interrupt included, is cached as empty, so a user who
said no is not asked again that session. Each scan raises one interrupt
per root, `std::skills::skillsDir` and `std::toolbox::scan`; both are
approved under `<agent-home>` by the `recommended` policy.

The LLM tools are built fresh from the cached entries on every call,
because entries are plain data a checkpoint can carry and partially
applied tools are not.

## Names

A learned tool is offered as `learned_<name>`. No built-in tool uses
that prefix (`toolWiring.agency` pins this), so a learned tool cannot
shadow one. Providers cap a tool name at 64 characters
(`MAX_TOOL_NAME_LEN`, declared in `std::skills` and imported by
`std::toolbox`), so a learned tool's own name is capped at 56
(`maxLearnedToolName()`). `designLearnedTool` refuses a longer name
before any prompt. An entry `listTools` reports as broken, or one
dropped into the directory by hand with a longer name, stays in the
catalog and is not offered, because one bad name fails every LLM call
that lists it.

## The coordinator's tools

`lib/agents/agency-agent/brains/coordinator/learn.agency` holds
`learnSkill(goal, name?, description?)` and
`writeToolFor(purpose, name?, request?)`. Each makes at most one model
call to draft what the caller left out (the skill body is always
drafted), calls the catalog's save operation, and phrases the reply.
The save operation runs the stdlib loop: `designSkill` shows the user
the whole file and redrafts on feedback; `designTool` has a coding
agent write the implementation, tests it, and shows it. Both end in the
stdlib's save gate. Nothing here adds a handler or a policy rule.

Under the `recommended` policy a save prompts more than once, because
`std::mkdir` and `std::write` under the agent home have no rule. A
skill takes the review, the save gate, a `mkdir`, and a `write`. A tool
takes a `mkdir` for its staging directory before any draft exists, the
coding agent's reads and writes in it, the review, and the save gate.

In a one-shot run (`-p`, piped stdin) the policy handler rejects every
undecided effect, the review included, so nothing could be saved. The
coordinator sets `setLearnOneShot` from `coordinatorInit`, and both
tools then refuse before drafting: no model call, no prompt.

## Files

- `lib/agents/agency-agent/lib/learned.agency`: the catalog, tested by
  `lib/agents/agency-agent/tests/learned.agency` over
  `tests/learned-fixture/`.
- `lib/agents/agency-agent/brains/coordinator/learn.agency`: the two
  tools, tested by `brains/coordinator/tests/learn.agency`. Run that
  with `AGENCY_USE_TEST_LLM_PROVIDER=1`, or the drafts go to a real
  model.
- `brains/coordinator/tests/toolWiring.agency`: no built-in tool uses
  the `learned_` prefix.
- `stdlib/skills.agency`: `listSkills`, the scan behind both
  `skillsDir` and the catalog; `tests/agency/skills-list.agency`.

Not yet done: handing `learnedExtras()` to each subagent, the `/skills`
and `/toolbox` commands, and an eval that teaches a skill, restarts, and
uses it.
