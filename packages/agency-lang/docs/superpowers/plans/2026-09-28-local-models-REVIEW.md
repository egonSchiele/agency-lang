# Anti-pattern review of the four local-model plans

Checked: `2026-09-28-local-models-dx.md`, `2026-09-28-vision-models.md`,
`2026-09-28-lora-package.md`, `2026-09-28-controlnet.md`, against
`docs/dev/contributing/anti-patterns.md` and the instruction that tools
be broadly useful and composable rather than single-purpose. Each
finding says what the draft did, which entry it matched, and what the
plan now says.

## Found and fixed

**Single-purpose loops as functions (composability).** The LoRA spec
had `captionFolder` and `previewLora`. Each was a loop over tools the
user already has: `glob`, `tagImage`, `write`; `generateImageLocal`,
`writeBinary`, and a paste. Each hid one decision inside a function, the
drop list and the seed. Both are gone. The one piece of knowledge they
carried, the style-tag list, is `export static const STYLE_TAGS`. The
loops are examples in the package, and `pasteImages` is a general tool
in `std::image` so a before-and-after pair and a contact sheet are the
same call.

**Imperative branching inside a declarative surface.** The vision plan's
server had "one method per route" with the family decided inside the
method (`tags` for WD14 did one thing, for Florence-2 another). That is
the "what" and the "how" in the same function. Now each family row
names a runner class, each runner has a method per route it lists, and
the handler dispatches by route to the runner. The family decides the
class once; no route method asks which family it is.

**Nested objects in a table.** The Florence-2 row had
`"tasks": {"captions": {"short": ..., "long": ...}}`. The catalog entry
is about TypeScript types, but the reason holds for a rules table that
tests compare to literals. The row is flat: `task_caption_short`,
`task_caption_long`.

**Imperative argv handling left unspecified.** The DX plan's Task 6 said
`serve` "parses its argv itself". That is an invitation to a loop with
mutable state in `scripts/agency.ts`. Now it is one pure function,
`groupServeArgv(argv): ServeTarget[]`, tested as a table of argv in and
targets out. It is a parser, so its order is its nature, and it has no
state past its return value.

**Duplicating existing code.** The LoRA plan said to import the Python
resolver "if it is exported, else write the four-step lookup in ten
lines". That is the catalog's first entry. Now a core PR moves
`choosePython` to `lib/stdlib/localPython.ts` so the package imports
it. The same check caught two more in the first draft and they were
written correctly from the start: `check_image_path` is shared through
`localServerCommon.py` by the vision and image servers, and
`folder_entry` is one function for the adapters folder and the
ControlNets folder.

**A convenience command with a switch.** `imageTools.py` was described
as a script with commands. Now the plan says each command is a function
of its arguments returning one dict, and `main` is a table lookup,
`COMMANDS = {"crop": crop, ...}`, so adding `paste` was a row.

## Checked and kept, with the reason

**"Declarative interfaces that encapsulate imperative complexity."**
The catalog's second entry asks for imperative code to live in a few
places behind a declarative interface, not for imperative code to be
absent. The plans do this on purpose in four places:

- `kindOfModelDir` is a rule table and one function that walks it.
  Every reader of a model's kind calls `recordedKind`; none reads a file.
- The vision and image family tables are data. The servers' imperative
  work, loading a model and running a request, is in one class per
  family and one method per route.
- `runTraining` in the LoRA package is the one place a child process is
  spawned, its lines parsed, and its abort handled. `trainLora` in
  Agency is a straight sequence of `const` bindings before one interrupt.
- `_visionRequest` is the one HTTP call behind three thin exports.

Each hides how; each interface says what. That is the entry's "good"
column, not its "bad" one.

**Order-dependent mutable state.** The image server's lazily loaded
adapter and ControlNet dicts are mutable caches under the generation
lock. They are keyed by name, filled on first use, never reordered, and
never read outside the lock. A cache is the one shape of mutable state
the entry's reasoning allows: no line depends on which other line ran
first.

**Cross-language tables.** `imageFamilies.json` and
`visionFamilies.json` repeat the Python tables' keys so TypeScript can
plan a model without running Python. That is a copy, guarded by a test
that runs the Python and compares, which is the pattern
`DIFFUSERS_VERSION` already uses between `localServe.ts` and the rules
module. The alternative, TypeScript reading the Python source, is
worse.

**Useless special cases.** `imageSize` raising `std::readImage` for a
read that returns two numbers looks like ceremony, but it is the same
read the reply pipeline makes, under the same effect, and a policy that
allows image reads under a folder covers it. Removing the effect would
make it the one file read in the stdlib with none.

**Tests where failure is catastrophic.** The symlink refusals are tested
against links the test makes in a temp directory, pointing at files the
test made. The abort test's cleanup deletes only `<out>.partial` through
`safeDeleteFile`. No test's failure mode touches a path the test did not
create.

## Still open

- `trainLora`'s pre-interrupt sequence is nine steps. They are `const`
  bindings from inputs, which is the entry's "good" shape, but it is a
  long function. When it is written, the estimate and the base-model
  lookup should each be a function so the Agency body reads as five
  lines.
- The DX plan's Task 3 deletes `_localModelCategory`. Three callers
  exist today (`checkKind`, `serveChoices`, the download picker).
  Deleting it is right; the plan should name the three so none is
  missed.
