# Architecture review: export the agent's compiled modules

A review of `docs/superpowers/plans/2026-11-24-export-agent-modules.md`, written 2026-11-24 by the plan's author. It follows the six checks of the architecture-review skill. Each finding says what was changed in the plan, or what is left for the owner to decide.

## Summary

The plan is one line in `package.json`, one test and one doc paragraph. That is in proportion to the change.

| # | Finding | Severity | What happened |
|---|---|---|---|
| 1 | The `exports` map is public API, and this entry exposes the agent's internals | Medium | No change. Deliberate, and the doc says what is promised. |
| 2 | The entry puts the build's folder layout into a path other programs depend on | Medium | Plan changed: the doc paragraph says so. |
| 3 | The unit test of the map entry could not fail on its own | Low | Plan changed: removed. |
| 4 | The new export is a second case of something that exists | Low | Plan changed: the doc names the first case. |

## 1. Major features and API

The package's `exports` map decides what any program can import from agency-lang. A new entry is a change to the package's public interface.

### Finding 1: the entry exposes the agent's internals

`./dist/lib/agents/agency-agent/*` makes every compiled module of `agency agent` importable, about 60 files. They were written as the agent's private code. Some hold run state in module variables, and the terminal's modules print when they load.

The downstream effect is on agency-lang itself. Once Perry imports 25 of these modules, a rename inside the agent breaks Perry's build at its next version bump. The break is loud and happens at compile time, and Perry pins an exact version, so nothing breaks until Perry chooses to move.

A narrower entry was considered: list only the modules Perry's core imports. Each new import in Perry would then need an agency-lang release first, which is the cost this work exists to remove. The wildcard stays.

The plan's doc paragraph already says the modules carry no promise. That is the right amount of ceremony. Nothing goes in the user-facing guide.

## 2. Effort and impact

| Task | Effort | Impact | Must do? |
|---|---|---|---|
| 1. The entry and its test | Small | High: Perry's plan cannot start without it | Yes |
| 2. The doc paragraph | Small | Low | Yes: the doc it replaces says the opposite |

The agency-js test adds one compile and one short run to CI, with no model call. That is a fair price: Perry's whole agent depends on this path, and the test also catches a build that stops shipping the `.agency` files in `dist/`.

### Finding 3: the unit test could not fail on its own

The first draft had a vitest test that read `package.json` and compared the entry with a string. The only way it fails is if someone deletes the line, and then the agency-js test fails too, with a clearer message. The plan no longer has it.

## 3. The 80/20 rule

The goal is that an Agency program outside the package can import the agent's modules. One line does all of it. There is no smaller version.

## 4. Reusing code

The plan adds no types and no code to the package. The test reuses the shape of `tests/agency-js/set-agent-name`.

## 5. Reusing and unifying concepts

### Finding 4: this is a second case of something that exists

The package already has an entry of this kind:

```json
"./stdlib-lib/*": "./dist/lib/stdlib/*",
```

It exposes the standard library's TypeScript helpers, which are also internal and also have no docs. Perry imports eight of them today. So "internal files a program outside may import at its own risk" is an existing idea in this package, and the new entry is another instance of it. The plan's doc paragraph now says the new entry has the same standing as `stdlib-lib`, so a reader learns one idea and not two.

The two entries cannot look alike, though. `stdlib-lib` is a short alias. The new entry must use the real folder path, because a `pkg::` import turns the path into a file name. The plan explains this in its Background.

## 6. Tying concepts together

### Finding 2: the build's folder layout becomes part of a path others depend on

The import path contains `dist/lib/agents/agency-agent/`. If the build ever puts the agent's compiled files somewhere else, or the agent's source folder is renamed, every import in Perry breaks.

Today that layout is an internal choice. After this PR it is something Perry's source names about 30 times. The plan accepts this, because a `pkg::` import leaves no way to use an alias. The doc paragraph now says that moving the folder is a breaking change for programs that import from it.

### What this PR does not tie

It does not make `agency agent` depend on Perry in code. The tie is one-way: Perry reads agency-lang's files. The cost falls on later agency-lang work that wants to delete or reshape one of these modules. Perry's plan and its review cover that.
