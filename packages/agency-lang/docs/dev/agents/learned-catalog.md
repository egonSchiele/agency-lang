# Learned skills and tools

`agency agent` keeps two kinds of thing a user teaches it across
sessions: skills, which are Markdown notes an agent reads on demand,
and tools, which are small Agency programs an agent can call. Both are
the stdlib's own formats, written and read by the stdlib's own
functions. The agent adds only the directories and the tool names.

- `<agent-home>/skills/<name>.md`: flat-layout skills, saved by
  `designSkill` from `std::skills`.
- `<agent-home>/tools/<name>/`: toolbox entries, saved by `designTool`
  from `std::toolbox`.

The agent home is `~/.agency-agent` or `AGENCY_AGENT_HOME`.

## The coordinator's tools

`lib/agents/agency-agent/brains/coordinator/learn.agency` offers the
coordinator `learnSkill(name, description, body)`, which is
`designSkill` in the skills directory, and
`writeToolFor(name, purpose, request)`, which is `designTool` in the
tools directory. The coordinator model writes the skill itself; there
is no drafting step of the agent's own. Each stdlib function runs its
review loop and its save gate, so the user sees every draft and
nothing is saved without their approval. Nothing here adds a handler or
a policy rule.

In a one-shot run (`-p`, piped stdin) the policy handler rejects every
undecided effect. `designSkill` raises its review first and `designTool`
makes its staging directory first, so both fail before any model call
and the tool replies that nothing was saved.

## What subagents get

`lib/agents/agency-agent/lib/learned.agency` builds `learnedExtras()`,
the list to add to a subagent's tools: `skillsDir` over the skills
directory as one `learned_skills` tool, then `runTool` partially
applied per saved tool as `learned_<name>`. It is built on each call,
so every dispatch scans both directories. Both scans are approved under
`<agent-home>` by the `recommended` policy. A directory that does not
exist is skipped without a prompt, and a rejected scan offers nothing.

## What the coordinator gets

`turnTools()` in `brains/coordinator/coordinator.agency` builds the
coordinator's list for one turn: its fixed tools, the MCP tools, then
`learnedExtras()`. It is built per turn, not once at startup, so a tool
saved in this session is callable on the next turn. The system prompt
tells the model the saved tools arrive as `learned_<name>` and that
`learned_skills` reads the skills; without that the model knows how to
save one but not that it can call one.

`runTool` takes its request as `Json`, so on its own the schema the
model sees for a learned tool would say only "any", and a model asked to
call one would send the whole request as JSON text. Instead the learned
tool's `request` parameter is given the JSON Schema of the tool's
`Request` type, with `withParamSchema` on the runtime's `AgencyFunction`.
The schema comes from `meta.json`, where `saveTool` records what the
tool's own `requestSchema` node returns (`schema(Request).toJSONSchema()`
in the tool template), so it is derived from the compiled type, not from
the type text. A tool saved before schemas were recorded has no
`requestSchema`; its description names the type instead.

Handing `learnedExtras()` to each subagent is not done yet, nor are
the `/skills` and `/toolbox` commands.

## Names

A learned tool is offered as `learned_<name>`. No built-in tool uses
that prefix (`toolWiring.agency` pins this), so a learned tool cannot
shadow one. Providers cap a tool name at 64 characters
(`MAX_TOOL_NAME_LEN`, declared in `std::skills` and imported by
`std::toolbox`), so a learned tool's own name is capped at 56
(`maxLearnedToolName()`). `writeToolFor` refuses a longer name before
any prompt. An entry `listTools` reports as broken, or one dropped into
the directory by hand with a longer name, is not offered, because one
bad name fails every LLM call that lists it.

## Tests

- `lib/agents/agency-agent/tests/learned.agency`, over
  `tests/learned-fixture/`.
- `lib/agents/agency-agent/brains/coordinator/tests/learn.agency`. No
  node makes a model call.
- `brains/coordinator/tests/toolWiring.agency`: no built-in tool uses
  the `learned_` prefix, and the coordinator's turn list offers the
  fixture's learned tools.
- `tests/agency/toolbox/designTool.agency`:
  `runToolAcceptsRequestAsJsonText`.
