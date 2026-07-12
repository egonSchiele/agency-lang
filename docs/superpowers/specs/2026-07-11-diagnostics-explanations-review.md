# Spec review: Diagnostic explanations (CLI lookup, generated docs, agent knowledge)

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-11-diagnostics-explanations-design.md`
**Reviewed:** 2026-07-11, verified against main and PR #517 (`diagnostics-overhaul` branch).

## Verdict

The architecture is right: explanations in a separate typed table (`Record<DiagnosticName, string>` as the compile-time coverage guarantee), categories promoted to data, docs as a build script mirroring `stdlib-stamp`, agent wiring that copies the existing guide/cli pipeline exactly. I verified the plumbing claims against the code and almost all of them hold. But the spec's central command name is already taken — `agency diagnostics` exists today and does something else entirely — and that collision invalidates the CLI section, the hint-line wording, and the docs-index prose as written. One command rename fixes all three. Beyond that: one omission in the agent wiring, one missing test, and a few plan-level notes.

## Must fix

### 1. `agency diagnostics` already exists — the spec's command family collides with it

`scripts/agency.ts:808` defines `.command("diagnostics")` today: a VSCode-facing command that takes `[inputs...]` (or stdin), parses each file, and prints `TarsecError` JSON. Under that definition, the spec's `agency diagnostics code AG2001` would parse `code` and `AG2001` as **input file paths** and try to read them. Registering a second `diagnostics` command is not an option, and grafting `code`/`list` subcommands onto the existing one breaks its positional-input contract (which the VSCode extension presumably drives).

Options, in preference order:
- **Name the new family `agency explain <code>`** — this is literally what the #474 spec called the deferred feature ("`agency explain <code>` ... fast-follow"). It is shorter, collision-free, and reads better in the hint line: `Run 'agency explain AG2001' for an explanation.` A `--list` flag or `agency explain --all` covers the list surface, or `agency explain` with no args prints the list.
- Rename the existing VSCode command (e.g. `parse-diagnostics`) and take the name — touches the VSCode extension's invocation, so strictly worse.

Whichever way, three places in this spec change together: the CLI section, the hint-line wording, and the docs `index.md` intro (which advertises the lookup command).

### 2. The agent wiring names two subagents; four have the docsSkill pattern

Surface 3 wires `diagnosticsSkill` into "the oracle and research subagents." The pattern the spec says it mirrors exists in **four** subagents:

- `lib/agents/agency-agent/subagents/oracle.agency:13-14`
- `lib/agents/agency-agent/subagents/research.agency:34-35`
- `lib/agents/agency-agent/subagents/code.agency:53-54`
- `lib/agents/agency-agent/subagents/explorer.agency:24-25`

The **code** subagent is the one that runs `typecheck` and fixes type errors — it needs the diagnostics pages more than any of the others. Explorer likely wants them too. Either wire all four or state explicitly which ones are excluded and why. As written this reads like an incomplete enumeration, not a decision.

## Should fix

### 3. Snippet parsing is an authoring convention with no test

The content model says explanations "may include a small Agency example (correct syntax per docs/site/guide/basic-syntax.md — verify snippets parse)" — but the Tests section never operationalizes that. Given this repo's documented history of Agency-syntax mistakes in prose (CLAUDE.md dedicates a section to it), ~70 hand-written markdown entries WILL accumulate broken snippets. Add test: extract every fenced code block from every explanation (and from the generated category pages, which is the same content) and run `parseAgency` on the Agency-tagged ones. Cheap, mechanical, and it converts the convention into a gate.

### 4. Pin "every code has a category" at the registry level, not just the generator level

The generator invariants ("each code appears on exactly one category page", "index lists every code exactly once") catch a code whose `AG#` prefix matches no `DIAGNOSTIC_CATEGORIES` entry — but only when the generator tests run, and the failure will read as a docs bug. The actual invariant is registry-shaped: *every code's prefix matches exactly one category*. Put it next to the existing uniqueness/format invariants in `diagnostics.test.ts` so a new AG8xxx code without a category entry fails in the registry suite with a message that says what to do.

### 5. "First error's code" needs one clarifying sentence

The hint names "the FIRST error's code" and "warnings-only output gets no hint." The errors array can lead with warnings (a warning at line 2, an error at line 9). The implementation must be `errors.find(e => e.severity === "error")`, not `errors[0]` — otherwise the hint can name a warning's code while claiming errors exist, or the two rules contradict. One sentence in the spec ("first error-severity diagnostic") closes it; also pin it in the hint-line test (list starting with a warning followed by an error → hint names the error's code).

## Plan-level notes (not spec defects)

- **Sequencing:** everything here imports `DiagnosticName` and the registry from PR #517. The plan should branch off `diagnostics-overhaul` or wait for its merge; if #517 picks up review changes (the stdlib `params` type fix is pending), rebase cost is nonzero.
- **Hint stream:** the `typecheck` action prints errors via `console.error` (`scripts/agency.ts:859`); the hint must go to the same stream or the review agent (which execs the CLI) can see the block without the hint depending on how it captures output.
- **Retired entries interact well:** a future `retired: true` registry entry still demands an explanation under `Record<DiagnosticName, string>` — which is correct (the docs keep explaining a code users may still see from older compilers). Worth one line in the explanations file's header comment so nobody "cleans it up."
- **`{placeholder}` leak test needs the escape rule:** the runtime pin "no unrendered `{placeholder}` outside code spans" must honor the `{{...}}` escape convention from #517's templates if any explanation quotes a template verbatim — reuse the same well-formedness check from `diagnostics.test.ts` rather than writing a second, subtly different regex.

## Verified against the code (positive evidence)

- `agency diagnostics` collision: `scripts/agency.ts:808-837` (VSCode parse-diagnostics, `[inputs...]` + stdin, TarsecError JSON) — the must-fix is real, not hypothetical.
- `stage-stdlib-docs` exists as a Makefile `define` (line 31) copying `docs/site/guide` and `docs/site/cli` into `stdlib/docs/`, invoked from three targets — the spec's staging addition drops in exactly as described.
- `scripts/stdlib-stamp.ts` precedent for build scripts compiled to `dist/scripts/` and invoked from the Makefile: exists; the generator mirrors it faithfully.
- `_docsDir(section: "guide" | "cli")` at `lib/stdlib/skills.ts:36` and `docsSkill(section: "guide" | "cli")` at `stdlib/skills.agency:200` — the union-widening claim is accurate, two sites as stated.
- `lib/cli/` helper convention (thin commander action, logic in a testable module): confirmed by the directory's existing shape (`doc.ts`, `coverage.ts`, `policy.ts`, ...); `lib/cli/diagnosticsCommand.ts` fits, though it should be renamed alongside the command (e.g. `explain.ts`).
- Both hint print sites exist where claimed: the typecheck command action (`scripts/agency.ts:~859`) and buildSession's `runTypecheck` failure print (`lib/compiler/buildSession.ts:646-652`). Keeping the hint out of `formatErrors` is the right altitude — `compile.ts` returns error strings to programmatic consumers and must stay clean.
- `docs/site/diagnostics/` does not exist on main — no collision on the docs side.

## Summary of required changes

1. Rename the command family — recommend `agency explain <code>` (the #474 spec's original name); update the hint line and docs-index prose to match. (`agency diagnostics` is taken: `scripts/agency.ts:808`.)
2. Wire `diagnosticsSkill` into all four docsSkill-bearing subagents (oracle, research, **code**, explorer) or name the exclusions deliberately.
3. Add the snippet-parse test for fenced Agency examples in explanations.
4. Move the code↔category coverage invariant into the registry test suite.
5. Specify "first error-severity diagnostic" for the hint and pin it with a warning-first test case.
