# Template Agency Follow-up Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Revised after review (`2026-07-23-template-agency-followup-fixes-REVIEW.md`) and one owner directive: **this PR does not modify `walkNodes`**. Any reachability gap the tripwire finds is recorded in a tracked table and fixed in a follow-up PR, because `walkNodes` feeds the symbol table and codegen and its changes deserve their own review. The tripwire is also built so that both the recorded gaps and any future forgetting fail tests by name.

**Goal:** Close three gaps left open when Template Agency (#665) merged: a structural walker-coverage tripwire, destructuring-pattern binders in hygiene, and fill errors that say which graft a problem came from.

**Architecture:** All three fixes live inside machinery that already exists. The tripwire is new corpus invariants in the test file that already crawls the corpus (`lib/utils/expressionSlots.test.ts`). Pattern binders extend `bindersOfNode` and the two rename walkers in `lib/runtime/template/hygiene.ts`. Origin attribution reads the `loc.origin` field that `fill` already stamps but nothing reads yet, in `lib/runtime/template/fill.ts` and `lib/utils/holes.ts`.

**Tech Stack:** TypeScript, vitest, the Agency test runner (`pnpm run agency test`).

## Global Constraints

- Work on a branch in a new worktree inside `/Users/adityabhargava/agency-lang/` (never the home directory, never on main). Fetch first — PR #666 merged after the local `origin/main` ref was last updated, and Task 2/3 edit a doc it added.
- **Do not modify `lib/utils/node.ts` (`walkNodes`) in this PR.** Gaps go in `KNOWN_WALKER_GAPS` (Task 1) and a follow-up issue.
- Never force-push or amend. Commit messages go in a file first (apostrophes break the CLI).
- Objects instead of maps, arrays instead of sets (JS `Set` only where object identity is the point and an array would be O(n²) — the tripwire's walked-node membership check is that case; see Task 1), types instead of interfaces, no dynamic imports.
- After changing `stdlib/agency.agency`, run `make`. After changing its docstrings, run `make doc`.
- Save test output to files; do not rerun to re-read failures. Do not run the full agency suite locally.
- Audit the final diff against `packages/agency-lang/docs/dev/anti-patterns.md` before the PR.

All file paths below are relative to `/Users/adityabhargava/agency-lang/packages/agency-lang/` unless they start with `/`.

---

## Background: what shipped, and what these three gaps are

Template Agency lets a template author write an Agency file with `#name` holes and fill them later, usually with values a model chose. Three pieces of that feature are load-bearing for safety:

1. **Hygiene** (`lib/runtime/template/hygiene.ts`): when a filler mentions a name the template also binds — or vice versa — `fill` renames the colliding binder to a fresh `__hyg<n>_` name so the filler cannot capture, say, a template variable holding an API key.
2. **The walker dependency**: hygiene finds names by walking the AST with `walkNodes` (`lib/utils/node.ts`). If the walker fails to descend into some expression position, hygiene under-reports free names there, no test fails, and capture avoidance **fails open** — the exact bug hygiene exists to prevent. Three such gaps were found during the feature's own development (guard-block head arguments, `try` operands, `is`-expression operands), each caught by a hand-enumerated list of 15 hole positions in `lib/parsers/hole.test.ts`.
3. **Origin stamps**: when a `Code` fragment grafts into a hole, `fill` deep-stamps `loc.origin = { kind: "filler", name: <holeName> }` onto every grafted node, because the fragment's line/column positions point into a source string that no longer exists.

The three gaps this plan closes:

**Gap 1 — the walker guarantee is a hand-written list.** The 15-position battery in `hole.test.ts` only covers positions someone thought to write down. That is the same "hand-written lists drift" failure mode that `expressionSlots.ts` was built to kill for the hoisting pass (its header tells the story: three drift holes in one week). The owner asked in the #665 review for a structural check derived from `expressionSlots` instead. The battery stays — it also proves holes *parse* in each position, which no structural check can — but the walker-reachability half of its job moves to corpus invariants that need no hand enumeration. `walkNodes` itself is used far beyond templates (symbol table, codegen scope resolution, LSP), so any gap the invariants find is **recorded, not fixed here** — the fix is its own PR where the codegen surface it touches gets its own review.

**Gap 2 — destructuring binders are invisible to hygiene.** Templates parse with `lower: false` (`lib/stdlib/agency.ts:200-210`), so destructuring survives to the AST hygiene walks: a `const { key } = getSecrets()` in a template is an `assignment` node whose `variableName` is the sentinel `"__destructured"` and whose real binders live in a `pattern` field (`lib/types.ts:245`, `lib/parsers/parsers.ts:3981`). `bindersOfNode` (`hygiene.ts:51`) reads only `variableName`, so it reports the sentinel and misses `key`. A `forLoop` can also carry a pattern (`itemVar: string | ObjectPattern | ArrayPattern`, `lib/types/forLoop.ts:24`) and the current `typeof node.itemVar === "string"` check silently skips it — and a `comprehension` carries the *identical* binder shape (`lib/types/comprehension.ts:22-23`) and is not handled at all. Concretely, this template leaks:

```ts
node main() {
  const { key } = getSecrets()
  const result = #userExpr
  print(result)
}
```

A filler that mentions `key` captures the secret, because hygiene never saw `key` as a template binder.

Scope ruling (review finding 8, decided): this task covers **binding patterns in binding positions** — `let`/`const` destructuring, for-loop binders, comprehension binders. Two binder families stay out of scope and stay *documented*: result-pattern bindings (`is success(v)` binds `v`, `lib/types/pattern.ts:45-49`) and match-arm pattern binders. Their scopes are conditional (the binding exists only inside one branch/arm), which needs flow-aware rename planning — a different design. The guide keeps an honest known-limit sentence for exactly those two, instead of the current blanket destructuring caveat.

**Gap 3 — origin stamps are write-only.** Nothing reads `loc.origin` today. The place it pays for itself is the composition workflow (the feature's flagship property): fill a guard template's `#body`, graft the result into a main template's `#helpers`, and the still-open `#minutes` hole now lives in the composed program with `origin: { kind: "filler", name: "helpers" }` on its `loc`. When a later `fill(program, { minutes: "two" })` fails the type check, the error should say the hole arrived via the `#helpers` graft. Same for `holesOf`: a model deciding what still needs filling should see which graft contributed each remaining hole.

Three recorded boundaries for gap 3:

- **Fill-path only.** `runCode` and `typecheck` take source *strings* (`stdlib/agency.agency:317`, `:381`) — the filled AST is printed by `toSource` and re-parsed, and `loc.origin` cannot survive that boundary. Compile-time diagnostics structurally cannot read origin until the separate "fragment type-check entry point" follow-up builds an AST-in compile path. The unused `"template"` member of the origin union (`lib/types/base.ts:9`) stays as reserved vocabulary.
- **Outermost graft wins.** `stampOrigin` unconditionally overwrites `loc.origin` (`fill.ts:287-292`), so in a three-level composition the innermost fragment's origin is rewritten at each graft. This is the right trade-off — the outermost graft is the one the *current* caller performed and can act on — but it is a decision: origin means "the hole this node **most recently** arrived through," and every doc sentence written in Task 3 must say it that way, never implying a chain.
- **Best-effort.** `stampOrigin` stamps only nodes that already carry a `loc` (line 287); `nodesFor` backfills a loc on the top node of each graft only (line 171). A loc-less inner hole yields `origin: null` and an unsuffixed error — quiet degradation, not a crash. The `holesOf` docstring says best-effort.

---

### Task 0: Worktree and branch

**Files:** none (setup).

- [ ] **Step 1: Fetch, then create the worktree and branch**

```bash
cd /Users/adityabhargava/agency-lang
git fetch origin
git worktree add worktree-template-fixes -b adit/template-agency-fixes origin/main
cd worktree-template-fixes && pnpm install
cd packages/agency-lang
```

- [ ] **Step 2: Confirm the branch and that #666's doc arrived**

Run: `git branch --show-current` — expected: `adit/template-agency-fixes`.
Run: `ls docs/dev/template-agency.md` — expected: exists (it merged with PR #666). If it somehow does not, skip every step below that edits it and record that in the PR description instead of inventing the file.

All later paths are relative to `worktree-template-fixes/packages/agency-lang/`.

---

### Task 1: Structural walker-coverage tripwire (no walker changes)

**Files:**
- Modify: `lib/utils/expressionSlots.test.ts` (corpus cache + smoke check + invariants + gap table)
- Modify: `lib/runtime/template/hygiene.ts:80-88` (the LOAD-BEARING comment on `freeNamesOf`)
- Modify: `lib/parsers/hole.test.ts:150-154` (the battery's framing comment)

**Interfaces:**
- Consumes: `expressionSlots(node)` from `lib/utils/expressionSlots.ts`; `walkNodesArray` from `lib/utils/node.ts`; `EXPRESSION_NODE_TYPES` from `lib/types.ts`.
- Produces: nothing at runtime — tests, comments, and two in-test tables later tasks and the follow-up PR rely on: `WALKER_EXCLUDED_FIELDS` (permanent rulings, keyed `"ownerType.field"`) and `KNOWN_WALKER_GAPS` (temporary, one entry per unfixed reachability gap, each self-deleting: the test asserts the gap still exists, so the follow-up walker fix cannot land without removing its entry).

**The invariants, and what each honestly guarantees** (review finding 4 applied):

- *Invariant A is a consistency check, not a reachability check.* For every node `walkNodes` *does* yield, every `expressionSlots(node).expr` must also be yielded. Both sides start from a walked node, so A can never prove a node reachable — what it pins is that the slot table and the walker agree about the children of everything walked. The historical `isExpression` gap is caught by A only because `isExpression` nodes were themselves reached through other positions. Membership is by object identity, which works because slots return the AST's own objects (`slot.expr` is `n.value`, `arg.value`, etc.) and `walkNodes` yields those same objects — including through the `unwrapCallArg` seam, which both sides share.
- *Invariant B does the real reachability work.* Crawl every field of the AST generically; every node found whose `type` is in `EXPRESSION_NODE_TYPES` must be yielded by `walkNodes`, unless reached through an excluded field or matching a known-gap entry. This is what catches positions nobody registered anywhere (the historical guard-head shape: expression nodes in a field neither table enumerated).

**How "hard to forget" works** (owner directive). Three mechanisms, one per way of forgetting:

1. Forget to give a **new node kind** walker descent → invariant B fails on the first corpus program containing it, naming the kind and file.
2. Forget that a **known gap** exists → it cannot be forgotten silently: `KNOWN_WALKER_GAPS` entries name the gap and the follow-up issue, and the tripwire *asserts each entry is still a gap* — so the follow-up PR that fixes `walkNodes` fails this test until it deletes the entry, and an entry whose gap was fixed by accident goes stale loudly, not quietly.
3. Forget the tripwire exists when editing `walkNodes` → the framing comments in `hygiene.ts` and `hole.test.ts` repoint there (Step 6), and the follow-up issue's body will link the table.

Exclusions are keyed by **owner type and field** — `"assignment.pattern"`, not `"pattern"` (review finding 5): `pattern` is also a field of `isExpression` and `typePattern` (`lib/types/pattern.ts:41,57`), and a ruling that silently covers node kinds nobody considered is not a ruling.

- [ ] **Step 1: Smoke-check the unlowered corpus parse before anything else**

Half of this task assumes the whole corpus parses with lowering off — a combination (`applyTemplate: true, lower: false`) no in-repo caller uses today (the only `lower: false` caller also passes `applyTemplate: false`, `lib/stdlib/agency.ts:205`). Learn in ten minutes whether that holds. Write a throwaway script in the scratchpad-mounted repo (NOT `/tmp`):

```bash
cat > /tmp/claude-smoke.mjs <<'EOF'
// run with: npx tsx /tmp/claude-smoke.mjs  (from packages/agency-lang)
EOF
```

Actually simpler: add the smoke check AS the first new test (it stays valuable — a corpus file that stops parsing unlowered should fail loudly forever). See Step 3's `corpusPrograms` — its parse-failure `throw` *is* the smoke check. So: implement Steps 2-3 first, then run ONLY the new describe block and triage parse failures before looking at coverage failures:

Run: `pnpm test:run lib/utils/expressionSlots.test.ts -t "walker coverage" > /tmp/claude-t1-smoke.log 2>&1; tail -40 /tmp/claude-t1-smoke.log`

If unlowered parsing fails on corpus files: report which files and why in the session before proceeding — if it is widespread, the unlowered half of the invariants runs over `tests/typescriptGenerator` only (or is dropped with the reason recorded in the test comment), and that is an owner-visible scope note for the PR description.

- [ ] **Step 2: Refactor the corpus loader — memoized, per-file, mode-keyed**

The existing suite parses the corpus once; naive addition would parse it ~7 times (review finding 6). In `lib/utils/expressionSlots.test.ts`, replace `corpusNodes()` (lines 189-205) with a cached split:

```ts
const corpusCache: Record<string, { file: string; nodes: AgencyNode[] }[]> = {};

function corpusPrograms(lower: boolean): { file: string; nodes: AgencyNode[] }[] {
  const cacheKey = lower ? "lowered" : "unlowered";
  if (corpusCache[cacheKey]) return corpusCache[cacheKey];
  const root = join(__dirname, "../..");
  const files = [
    ...collectAgencyFiles(join(root, "stdlib")),
    ...collectAgencyFiles(join(root, "tests/typescriptGenerator")),
  ];
  expect(files.length).toBeGreaterThan(50);
  const out: { file: string; nodes: AgencyNode[] }[] = [];
  for (const file of files) {
    const parsed = parseAgency(readFileSync(file, "utf8"), {}, true, lower);
    if (!parsed.success) {
      throw new Error(`corpus file failed to parse (lower: ${lower}): ${file}: ${parsed.message}`);
    }
    out.push({ file, nodes: parsed.result.nodes as AgencyNode[] });
  }
  corpusCache[cacheKey] = out;
  return out;
}

function corpusNodes(): { file: string; node: any }[] {
  const out: { file: string; node: any }[] = [];
  for (const { file, nodes } of corpusPrograms(true)) {
    for (const node of walkEveryNode(nodes)) out.push({ file, node });
  }
  return out;
}
```

The existing four corpus invariants keep consuming `corpusNodes()` unchanged (it now reuses the lowered cache). Import `walkNodesArray` from `./node.js`.

- [ ] **Step 3: Add the walker-coverage describe block**

Append to `lib/utils/expressionSlots.test.ts`:

```ts
// ── Walker coverage ─────────────────────────────────────────────────
// Template hygiene's free-name analysis (freeNamesOf, hygiene.ts) is
// exactly as complete as walkNodes' descent: a position the walker
// misses under-reports free names, no test fails, and a filler silently
// captures a template binder — capture avoidance failing OPEN. walkNodes
// also backs the symbol table, codegen scope resolution, and the LSP, so
// these invariants guard far more than templates. They run in BOTH parse
// modes: lowered (the compile pipeline's view) and unlowered (the
// template/hygiene view, with patterns and comprehensions intact).
//
// POLICY: fixing walkNodes is never done in the same PR that discovers a
// gap — its consumers (scope resolution → codegen) make every descent
// change a compiler change. A discovered gap gets a KNOWN_WALKER_GAPS
// entry naming a follow-up issue; the fix PR must delete the entry or
// this suite fails, so the gap cannot be silently forgotten in either
// direction.

// Fields whose expression-typed contents the walker deliberately does
// not yield, keyed "ownerType.field" — a bare field name would silently
// cover every node kind sharing the spelling ("pattern" is also a field
// of isExpression and typePattern). Every entry is a recorded ruling.
const WALKER_EXCLUDED_FIELDS: Record<string, string> = {
  "*.loc": "positions, not nodes",
  "assignment.matchSource": "cloned, body-free snapshot for the type checker — not live AST",
  "assignment.pattern": "binding pattern: variableName members are binders, not uses",
  "forLoop.itemVar": "for-loop binder (string or pattern), not a use",
  "comprehension.itemVar": "comprehension binder, same shape and ruling as forLoop.itemVar",
};

// Temporary entries: reachability gaps found by the invariants below,
// awaiting their own walker-fix PR. Keyed like WALKER_EXCLUDED_FIELDS;
// the value names the follow-up issue. The staleness test asserts each
// entry still IS a gap, so the fix PR cannot land without deleting it.
const KNOWN_WALKER_GAPS: Record<string, string> = {
  // filled in by Step 4's triage, e.g.:
  // "functionParameter.defaultValue": "#<issue>: walkNodes does not descend into parameter defaults",
};

function isExcluded(ownerType: string, key: string): boolean {
  return (
    Object.hasOwn(WALKER_EXCLUDED_FIELDS, `*.${key}`) ||
    Object.hasOwn(WALKER_EXCLUDED_FIELDS, `${ownerType}.${key}`)
  );
}

function isKnownGap(ownerType: string, key: string): boolean {
  return Object.hasOwn(KNOWN_WALKER_GAPS, `${ownerType}.${key}`);
}

function* structuralNodes(
  value: any,
  ownerType: string,
  via: "clear" | "excluded" | "knownGap",
): Generator<{ node: any; via: "clear" | "excluded" | "knownGap" }> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* structuralNodes(item, ownerType, via);
    return;
  }
  const selfType = typeof value.type === "string" ? value.type : ownerType;
  if (typeof value.type === "string") yield { node: value, via };
  for (const key of Object.keys(value)) {
    const childVia =
      via !== "clear"
        ? via
        : isExcluded(selfType, key)
          ? "excluded"
          : isKnownGap(selfType, key)
            ? "knownGap"
            : "clear";
    yield* structuralNodes(value[key], selfType, childVia);
  }
}

describe("walker coverage: walkNodes reaches every expression position", () => {
  for (const lower of [true, false]) {
    const label = lower ? "lowered" : "unlowered";

    it(`${label}: slot-table agreement — every expression slot of a walked node is itself walked`, () => {
      // A CONSISTENCY check, not reachability: both sides start from a
      // node the walker already yielded, so this can never prove a node
      // reachable. What it pins is that expressionSlots and walkNodes
      // agree about the children of everything walked. Reachability is
      // the structural invariant below.
      for (const { file, nodes } of corpusPrograms(lower)) {
        const walked = new Set(walkNodesArray(nodes).map((v) => v.node));
        for (const node of walked) {
          for (const slot of expressionSlots(node as AgencyNode)) {
            expect(
              walked.has(slot.expr),
              `${file}: walkNodes does not descend into a ${(node as any).type} expression slot ` +
                `(slot expr type: ${(slot.expr as any).type}) — template hygiene cannot see names there`,
            ).toBe(true);
          }
        }
      }
    });

    it(`${label}: structural reachability — every expression node in the AST is walked`, () => {
      for (const { file, nodes } of corpusPrograms(lower)) {
        const walked = new Set(walkNodesArray(nodes).map((v) => v.node));
        for (const { node, via } of structuralNodes(nodes, "(root)", "clear")) {
          if (via !== "clear") continue;
          if (!EXPRESSION_NODE_TYPES.includes(node.type)) continue;
          expect(
            walked.has(node),
            `${file}: a ${node.type} node is reachable in the AST but never yielded by walkNodes. ` +
              `Do NOT fix walkNodes in this PR — add a KNOWN_WALKER_GAPS entry naming a follow-up ` +
              `issue, or, if the non-walk is deliberate, a WALKER_EXCLUDED_FIELDS ruling.`,
          ).toBe(true);
        }
      }
    });

    it(`${label}: known gaps are still gaps (staleness guard)`, () => {
      // Each KNOWN_WALKER_GAPS entry must still shield at least one
      // unwalked expression node. When the follow-up PR fixes walkNodes,
      // this fails until the entry is deleted — the gap cannot be
      // forgotten in either direction.
      const shielded: Record<string, boolean> = {};
      for (const key of Object.keys(KNOWN_WALKER_GAPS)) shielded[key] = false;
      if (Object.keys(shielded).length === 0) return;
      for (const { nodes } of corpusPrograms(lower)) {
        const walked = new Set(walkNodesArray(nodes).map((v) => v.node));
        for (const { node, via } of structuralNodes(nodes, "(root)", "clear")) {
          if (via !== "knownGap") continue;
          if (!EXPRESSION_NODE_TYPES.includes(node.type)) continue;
          if (!walked.has(node)) {
            // Attribute laziness: any still-unwalked shielded node keeps
            // every entry alive only if we can name its owner — so track
            // per-entry via a second pass below instead.
          }
        }
      }
      // Simpler per-entry check: temporarily disable the entry and see
      // whether the reachability walk would now flag something.
      for (const key of Object.keys(KNOWN_WALKER_GAPS)) {
        let stillAGap = false;
        for (const { nodes } of corpusPrograms(lower)) {
          const walked = new Set(walkNodesArray(nodes).map((v) => v.node));
          const [ownerType, field] = key.split(".");
          for (const visit of walkNodesArray(nodes)) {
            const source = visit.node as any;
            if (source.type !== ownerType) continue;
            for (const { node } of structuralNodes(source[field], ownerType, "clear")) {
              if (EXPRESSION_NODE_TYPES.includes(node.type) && !walked.has(node)) {
                stillAGap = true;
              }
            }
          }
        }
        expect(
          stillAGap,
          `KNOWN_WALKER_GAPS entry "${key}" no longer shields anything in the ${label} corpus — ` +
            `the walker gap it recorded is fixed (or the corpus lost the shape). Delete the entry ` +
            `(and close ${KNOWN_WALKER_GAPS[key]}) or restore corpus coverage.`,
        ).toBe(true);
      }
    });
  }

  it("liveness: the corpus actually exercises the historically-missed positions", () => {
    // A coverage invariant over kinds the corpus never contains proves
    // nothing. Pin the kinds whose walker descent was added by hand
    // during Template Agency development, in the mode each occurs in.
    const walkedKinds = (lower: boolean): Record<string, true> => {
      const seen: Record<string, true> = {};
      for (const { nodes } of corpusPrograms(lower)) {
        for (const v of walkNodesArray(nodes)) seen[(v.node as any).type] = true;
      }
      return seen;
    };
    const lowered = walkedKinds(true);
    const unlowered = walkedKinds(false);
    for (const kind of ["guardBlock", "tryExpression"]) {
      expect(lowered[kind], `corpus (lowered) never contains a ${kind}`).toBe(true);
    }
    for (const kind of ["isExpression", "comprehension"]) {
      expect(unlowered[kind], `corpus (unlowered) never contains a ${kind}`).toBe(true);
    }
  });
});
```

Implementation note on the staleness guard: the first inner loop in the sketch above is vestigial scaffolding — implement only the per-entry check (the second loop), which is the one with teeth. Simplify to taste; keep the failure message.

`Set` here is deliberate despite the arrays-not-sets house rule: membership is by object identity over tens of thousands of nodes per file, and `array.includes` would make the invariants quadratic. Note this in the PR description.

- [ ] **Step 4: Run, then triage every failure with this decision rule**

Run: `pnpm test:run lib/utils/expressionSlots.test.ts > /tmp/claude-t1-tripwire.log 2>&1; tail -80 /tmp/claude-t1-tripwire.log`

Expect failures on the first run — finding them is the point. For each:

1. **Unlowered parse failure** (from Step 1's smoke): triage as described there before anything else.
2. **Liveness failure** (a pinned kind missing from the corpus): add a small `.agency` file under `tests/typescriptGenerator/` exercising that shape, then run `make fixtures`. Check how neighboring fixtures are laid out first and match them.
3. **Reachability failure**: decide *deliberate non-walk* vs *gap*.
   - Deliberate (the field's contents are binders, metadata, or clones — the walker *should not* yield them): add a `WALKER_EXCLUDED_FIELDS` ruling with a real justification.
   - Gap (the field holds genuine expression uses the walker should see — the known candidate from research is `functionParameter.defaultValue`): add a `KNOWN_WALKER_GAPS` entry. **Do not touch `walkNodes`.** After the PR exists, file one follow-up issue listing every entry, and backfill the issue number into the entries (a follow-up commit on the same branch is fine).
   An exclusion that amounts to "the walker just doesn't" is a gap, not a ruling.

Then rerun the file until green: `pnpm test:run lib/utils/expressionSlots.test.ts > /tmp/claude-t1-tripwire2.log 2>&1; tail -10 /tmp/claude-t1-tripwire2.log`

- [ ] **Step 5: Sanity-check the tripwire has teeth (throwaway mutation)**

Temporarily comment out the `isExpression` descent in a *local scratch copy* check: rather than editing `node.ts` (banned), verify teeth the safe way — add a temporary bogus entry to `KNOWN_WALKER_GAPS` (e.g. `"assignment.value": "bogus"`) and confirm the staleness guard fails naming it; then remove it. This proves the guard actually detects fixed/nonexistent gaps.

Run: `pnpm test:run lib/utils/expressionSlots.test.ts -t "staleness" > /tmp/claude-t1-teeth.log 2>&1; tail -10 /tmp/claude-t1-teeth.log`
Expected: FAIL naming `assignment.value` with the bogus entry present; PASS after removing it.

- [ ] **Step 6: Repoint the two comments that name the battery as the tripwire**

In `lib/runtime/template/hygiene.ts`, the `freeNamesOf` comment (lines 80-88) ends with: "If you add a node kind with expression children, audit the walker's descent AND add that position to the hole-position battery in lib/parsers/hole.test.ts, which is the tripwire for this path." Replace that final sentence with:

```
 *  The tripwire for this path is the walker-coverage corpus invariants in
 *  lib/utils/expressionSlots.test.ts ("walker coverage" describe block):
 *  they check, structurally and in both parse modes, that walkNodes
 *  reaches every expression position — no hand enumeration to forget.
 *  Gaps they have found but not yet fixed are listed there in
 *  KNOWN_WALKER_GAPS; hygiene inherits each one until its walker-fix PR
 *  lands.
```

In `lib/parsers/hole.test.ts`, replace the battery's framing comment (lines 150-154) with:

```ts
// Parser coverage: a hole must PARSE in each of these positions. Walker
// reachability — the half of this list that used to guard template
// hygiene's free-name analysis — is now enforced structurally by the
// walker-coverage corpus invariants in lib/utils/expressionSlots.test.ts,
// so a position missing from this list is a parser-coverage gap only.
```

Keep the battery's entries themselves: they are the only tests proving the *parser* accepts a hole in each position.

- [ ] **Step 7: Full verification and commit**

Run: `pnpm test:run > /tmp/claude-t1-final.log 2>&1; tail -5 /tmp/claude-t1-final.log` — expected: all pass.
Run: `pnpm run lint:structure` — expected: clean.

```bash
git add lib/utils/expressionSlots.test.ts lib/runtime/template/hygiene.ts lib/parsers/hole.test.ts
git add tests/typescriptGenerator/   # only if liveness fixtures were added
git status   # verify ONLY intended files are staged — no broad sweeps
printf 'Walker-coverage tripwire: corpus invariants replace the hand-enumerated battery\n\nTemplate hygiene fails open when walkNodes misses an expression\nposition. Structural corpus invariants (slot-table agreement plus\nstructural reachability, in both parse modes) now guard that. Gaps they\nfind are recorded in KNOWN_WALKER_GAPS with a staleness guard, so the\nwalker fix lands in its own PR and cannot be forgotten in either\ndirection. walkNodes itself is deliberately untouched here.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude-commit-t1.txt
git commit -F /tmp/claude-commit-t1.txt
```

---

### Task 2: Destructuring-pattern binders in hygiene

**Files:**
- Modify: `lib/runtime/template/hygiene.ts` (`bindersOfNode`, `directBinders`, `isNameField`, both rename walkers)
- Modify: `lib/runtime/template/hygiene.test.ts` (new cases)
- Modify: `docs/site/guide/templates.md:150` (replace the known-limit paragraph with the narrower honest one)
- Modify: `docs/dev/template-agency.md` (update its pattern-binder limitation)

**Interfaces:**
- Consumes: `BindingPattern`, `ObjectPattern`, `ArrayPattern` from `lib/types.js` (verify the re-export; fall back to `lib/types/pattern.js`).
- Produces: `patternBinders(pattern): string[]` (module-private to hygiene.ts); renaming behavior described below, relied on by nothing outside `fill`.

**Design notes, before the steps.** Four subtleties an implementer must not discover mid-edit:

1. *The sentinel.* A destructuring `const { key } = …` is an `assignment` with `variableName: "__destructured"` and the real binders in `pattern`. Returning the sentinel as a binder is today's bug; when `pattern` is present, the pattern's names are the binders and the sentinel is noise.
2. *Shorthand renames must not change the read.* In `{ tmp }`, the binder name `tmp` is ALSO the object key being read. Renaming it in place to `{ __hyg1_tmp }` would read a different property. The rename must expand the shorthand: `{ tmp: __hyg1_tmp }` — key kept, binder fresh. The printer already handles this shape: `formatObjectPattern` prints `key: value` whenever the value name differs from the key and collapses back to shorthand when they match (`lib/backends/agencyGenerator.ts:901-916`) — no printer work needed, and this fact is why the Step 1 assertions on printed source are safe. `objectPatternProperty` needs no such care: its `key` is a plain string field the generic walkers never touch, and its `value` binder is a `variableName` node the existing `isNameField` rename already covers.
3. *Uses rename for free; binder fields mostly do too.* Both rename walkers (`renameNode` and `applyScopedRenames.walk`) recurse every field generically and rewrite via `isNameField`. Pattern-held `variableName` nodes (array elements, property values) are therefore already renamed. What is NOT covered: `restPattern.identifier` (a plain string field — add to `isNameField`) and shorthand (needs the expansion above, a node-shape change no field rename can express).
4. *Comprehensions are the same fix.* `Comprehension.itemVar` has the identical `string | ObjectPattern | ArrayPattern` shape as `forLoop` (`lib/types/comprehension.ts:22-23`), survives unlowered parses, and its binder is currently invisible to hygiene — same one-branch fix, same `isNameField` extension.

- [ ] **Step 1: Write the failing tests**

Add to `lib/runtime/template/hygiene.test.ts`, **reusing the file's existing helpers** for building templates and fillers (read the top of the file first; it builds `Code` values via the template module's parse helpers — match its imports and style rather than inventing new helpers):

```ts
describe("pattern binders", () => {
  it("a template destructuring binder colliding with a filler free name is renamed, shorthand expanded", () => {
    // Template binds `key` via shorthand destructuring; filler uses a free `key`.
    const template = loadFromString(`node main() {\n  const { key } = getSecrets()\n  const result = #userExpr\n  print(key)\n}\n`);
    const filler = parseExprHelper("key + 1");
    const filled = fillHoles(template, { userExpr: filler });
    const source = toSourceHelper(filled);
    // The template's binder got a fresh name, the KEY it reads did not,
    // and the filler's `key` kept its spelling.
    expect(source).toMatch(/const \{ key: __hyg\d+_key \} = getSecrets\(\)/);
    expect(source).toMatch(/const result = key \+ 1/);
    expect(source).toMatch(/print\(__hyg\d+_key\)/);
  });

  it("a filler destructuring binder colliding with a visible template binder is renamed", () => {
    const template = loadFromString(`node main() {\n  const tmp = 1\n  #steps\n  print(tmp)\n}\n`);
    const filler = parseStatementsHelper(`const { tmp } = load()\nprint(tmp)`);
    const source = toSourceHelper(fillHoles(template, { steps: filler }));
    // Filler's binder renamed (with shorthand expansion); template untouched.
    expect(source).toMatch(/const \{ tmp: __hyg\d+_tmp \} = load\(\)/);
    expect(source).toMatch(/const tmp = 1/);
  });

  it("array-pattern and rest binders participate in collisions", () => {
    const template = loadFromString(`node main() {\n  const [a, ...rest] = items()\n  const x = #v\n  print(rest)\n}\n`);
    const filler = parseExprHelper("rest");
    const source = toSourceHelper(fillHoles(template, { v: filler }));
    expect(source).toMatch(/const \[a, \.\.\.__hyg\d+_rest\] = items\(\)/);
    expect(source).toMatch(/const x = rest\b/);
  });

  it("a for-loop destructuring binder participates in collisions", () => {
    const template = loadFromString(`node main() {\n  for ({ name } in people()) {\n    const x = #v\n    print(name)\n  }\n}\n`);
    const filler = parseExprHelper("name");
    const source = toSourceHelper(fillHoles(template, { v: filler }));
    expect(source).toMatch(/for \(\{ name: __hyg\d+_name \} in people\(\)\)/);
    expect(source).toMatch(/const x = name\b/);
  });

  it("a comprehension binder participates in collisions", () => {
    const template = loadFromString(`node main() {\n  const doubled = [n * 2 for n in nums()]\n  const x = #v\n  print(doubled)\n}\n`);
    const filler = parseExprHelper("n");
    const source = toSourceHelper(fillHoles(template, { v: filler }));
    expect(source).toMatch(/__hyg\d+_n \* 2 for __hyg\d+_n in nums\(\)/);
    expect(source).toMatch(/const x = n\b/);
  });

  it("maxHygieneIndex sees __hyg names inside patterns (seeding)", () => {
    const code = loadFromString(`node main() {\n  const { k: __hyg7_k } = load()\n  return __hyg7_k\n}\n`);
    expect(maxHygieneIndex(code)).toBe(7);
  });

  it("an inner def that destructures a name stops an outer rename at its door (shadowing)", () => {
    const template = loadFromString(
      `const tmp = 1\n\ndef inner(): number {\n  const { tmp } = load()\n  return tmp\n}\n\nnode main() {\n  const x = #v\n  return tmp\n}\n`,
    );
    const filler = parseExprHelper("tmp");
    const source = toSourceHelper(fillHoles(template, { v: filler }));
    // The global tmp is renamed; inner's destructured tmp shadows and stays.
    expect(source).toMatch(/const \{ tmp \} = load\(\)/);
  });
});
```

Adjust helper names to what the file actually uses. Verify every Agency snippet parses **before** relying on it — write a scratch `.agency` file inside the repo (NOT `/tmp`) and run `pnpm run ast` on it; the comprehension and destructuring spellings especially (check `tests/typescriptGenerator/` for existing fixtures of both and mirror them). Note the shorthand-shadowing assertion in the last test rides on the printer's collapse-when-equal behavior (design note 2).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:run lib/runtime/template/hygiene.test.ts > /tmp/claude-t2-red.log 2>&1; tail -40 /tmp/claude-t2-red.log`
Expected: the new cases FAIL (binders not found / names not renamed). If a case fails on *parsing* instead, fix the test's Agency syntax first — that is not the bug under test.

- [ ] **Step 3: Implement `patternBinders` and wire it into the binder readers**

In `lib/runtime/template/hygiene.ts`, add above `bindersOfNode`:

```ts
import type { ArrayPattern, BindingPattern, ObjectPattern } from "../../types.js";

/** Names a binding pattern introduces. Fed only from binding positions
 *  (let/const, for-loop and comprehension binders), where the parser
 *  produces binding patterns only. Match-position kinds that can share
 *  these unions (literals, wildcards, resultPattern) bind nothing here —
 *  note that skipping resultPattern is also why `is success(v)` binders
 *  stay untracked (recorded known limit, see the templates guide). */
function patternBinders(pattern: BindingPattern): string[] {
  if (pattern.type === "variableName") return [pattern.value];
  if (pattern.type === "restPattern") return [pattern.identifier];
  if (pattern.type === "wildcardPattern") return [];
  if (pattern.type === "arrayPattern") {
    return (pattern as ArrayPattern).elements.flatMap((element) =>
      isBindingPattern(element) ? patternBinders(element) : [],
    );
  }
  return (pattern as ObjectPattern).properties.flatMap((property) => {
    if (property.type === "objectPatternShorthand") return [property.name];
    if (property.type === "restPattern") return [property.identifier];
    return isBindingPattern(property.value) ? patternBinders(property.value) : [];
  });
}

function isBindingPattern(value: { type: string }): value is BindingPattern {
  return (
    value.type === "variableName" ||
    value.type === "objectPattern" ||
    value.type === "arrayPattern" ||
    value.type === "restPattern" ||
    value.type === "wildcardPattern"
  );
}
```

Rewire `bindersOfNode` (replace its assignment and forLoop branches; the v1-limit comment comes out):

```ts
function bindersOfNode(node: AgencyNode): string[] {
  if (node.type === "assignment" && node.declKind && !node.accessChain) {
    // A destructuring assignment holds the sentinel "__destructured" in
    // variableName; the real binders live in `pattern`.
    if (node.pattern) return patternBinders(node.pattern);
    return [node.variableName];
  }
  if (node.type === "function" || node.type === "graphNode") {
    return node.parameters.map((param) => param.name);
  }
  if (node.type === "forLoop" || node.type === "comprehension") {
    const names =
      typeof node.itemVar === "string" ? [node.itemVar] : patternBinders(node.itemVar);
    if (node.indexVar) names.push(node.indexVar);
    return names;
  }
  return [];
}
```

And `directBinders` (the shadow-stop — it reads `stmt.variableName` today and would report the `__destructured` sentinel as a shadowing name):

```ts
for (const stmt of node.body) {
  if (stmt.type === "assignment" && stmt.declKind && !stmt.accessChain) {
    names.push(...(stmt.pattern ? patternBinders(stmt.pattern) : [stmt.variableName]));
  }
}
```

- [ ] **Step 4: Teach both rename walkers rest identifiers, comprehension binders, and shorthand expansion**

Extend `isNameField`:

```ts
function isNameField(source: Record<string, unknown>, key: string): boolean {
  return (
    (source.type === "variableName" && key === "value") ||
    (source.type === "assignment" && key === "variableName") ||
    (source.type === "functionParameter" && key === "name") ||
    (source.type === "forLoop" && (key === "itemVar" || key === "indexVar")) ||
    (source.type === "comprehension" && (key === "itemVar" || key === "indexVar")) ||
    (source.type === "restPattern" && key === "identifier")
  );
}
```

(`itemVar` as a *pattern* is an object, so the `typeof field === "string"` guard both walkers already apply keeps the field-rename path from touching it; the pattern's contents rename through generic recursion.)

Add the shared shorthand expansion. `ObjectPatternShorthand` and `ObjectPatternProperty` are **not** `BaseNode` — they carry no `loc` (`lib/types/pattern.ts:5-16`) — so the constructed nodes carry none either:

```ts
/** A shorthand `{ tmp }` binds `tmp` FROM the object key `tmp`. Renaming
 *  in place would read a different property, so a renamed shorthand
 *  expands to `key: freshName` instead. The generator collapses back to
 *  shorthand only when key and name match, so the expansion prints as
 *  `{ tmp: __hygN_tmp }`. */
function expandShorthand(
  source: Record<string, unknown>,
  map: Record<string, string>,
): Record<string, unknown> | null {
  if (source.type !== "objectPatternShorthand") return null;
  const name = source.name as string;
  if (!(name in map)) return null;
  return {
    type: "objectPatternProperty",
    key: name,
    value: { type: "variableName", value: map[name] },
  };
}
```

Wire it into `renameNode`, right after the null/primitive guard:

```ts
const source = value as Record<string, unknown>;
const expanded = expandShorthand(source, renames);
if (expanded) return expanded;
```

And into `applyScopedRenames`'s `walk`, after `map` is built:

```ts
const expanded = expandShorthand(source, map);
if (expanded) return expanded;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:run lib/runtime/template/hygiene.test.ts lib/runtime/template/fill.test.ts > /tmp/claude-t2-green.log 2>&1; tail -20 /tmp/claude-t2-green.log`
Expected: PASS, including all pre-existing hygiene/fill cases (selectivity, seeding, shadowing, mutation trio).

- [ ] **Step 6: Replace the documented limitation with the narrower honest one**

In `docs/site/guide/templates.md`, replace the paragraph at line ~150 ("One current limit: destructuring-pattern binders are not tracked for collisions. …") with:

```markdown
Two binder forms are not yet tracked for collisions: names bound by result
patterns (`if (r is success(v)) { … }` binds `v`) and names bound inside
match arms. If a filler or template uses one of those names on the other
side, rename it yourself. Destructuring binders — `const { key } = …`,
array and rest patterns, for-loop and comprehension binders — are tracked
like any other name.
```

In `docs/dev/template-agency.md`, find the pattern-binder limitation in its nuances/known-limits section and rewrite it the same way: object/array/rest/for-loop/comprehension binders tracked, shorthand expansion as the nuance worth keeping (renaming `{ tmp }` in place would change the property read, so it expands to `{ tmp: __hygN_tmp }`), result-pattern and match-arm binders recorded as the remaining limits (their bindings are branch-scoped, which needs flow-aware rename planning).

- [ ] **Step 7: Full verification and commit**

Run: `pnpm test:run > /tmp/claude-t2-final.log 2>&1; tail -5 /tmp/claude-t2-final.log` — all pass.
Run: `pnpm run lint:structure` — clean.

```bash
git add lib/runtime/template/ docs/site/guide/templates.md docs/dev/template-agency.md
git status   # verify only intended files
printf 'Template hygiene tracks destructuring-pattern binders\n\nbindersOfNode read only assignment.variableName, so a template binder\nintroduced by destructuring was invisible to collision detection and a\nfiller could capture it. Pattern binders (object, array, rest, for-loop,\ncomprehension) now participate; renamed shorthands expand to\nkey: freshName so the property read is unchanged. Result-pattern and\nmatch-arm binders remain documented limits (branch-scoped bindings need\nflow-aware planning).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude-commit-t2.txt
git commit -F /tmp/claude-commit-t2.txt
```

---

### Task 3: Fill errors and `holesOf` read `loc.origin`

**Files:**
- Modify: `lib/runtime/template/fill.ts` (origin suffix on fill-path errors)
- Modify: `lib/utils/holes.ts` (`HoleInfo.origin`)
- Modify: `stdlib/agency.agency` (the `HoleInfo` type + `holesOf` docstring)
- Modify: `lib/runtime/template/fill.test.ts`, `lib/stdlib/template.test.ts` (new cases)
- Create: `tests/agency/templates/holesOfOrigin.agency` + sibling template files `holesOfOriginInner.agency`, `holesOfOriginOuter.agency` (following `tests/agency/templates/composeGuarded.agency`'s conventions exactly)
- Modify: `docs/site/guide/templates.md` (holesOf example + composition section), `docs/dev/template-agency.md` (origin section)

**Interfaces:**
- Consumes: `SourceLocation.origin?: { kind: "template" | "filler"; name: string }` (`lib/types/base.ts:9`), stamped by `stampOrigin`/`fillerLoc` in `fill.ts`.
- Produces: `HoleInfo` gains `origin: string | null` — the hole name of the graft this hole **most recently** arrived through (outermost graft wins on re-stamp; see Background), else null; best-effort (loc-less inner nodes yield null). Error messages on the fill path gain the suffix `` (in code grafted by the fill for `#<name>`) `` when the anchoring node carries a filler origin. Agency-side `HoleInfo` type mirrors the new field.

**Worked example the tests pin down.** The composition workflow from the guide — with the type constraint written where the machinery can actually see it. Fill-time type validation reads the hole's own annotation or its annotated-assignment parent (`fill.ts:130-140`, `lib/utils/holes.ts:54-69`); a bare hole in a named-argument position supplies *no* expected type and validation silently passes, so the guard template routes `#minutes` through an annotated assignment:

```
// guard template (inner)
def guarded(): string {
  const ms: number = #minutes
  const r = guard(time: ms) {
    #body
  }
  return "done"
}
```

After `fill(mainTpl, { helpers: partialGuard })`, the `#minutes` hole node inside the composed program carries `loc.origin = { kind: "filler", name: "helpers" }`. Then:

- `holesOf(program.value)` returns `[{ name: "minutes", sort: "expr", splice: false, type: "number", origin: "helpers" }]`.
- `fill(program.value, { minutes: "two" })` fails with: ``The hole `#minutes` expects `number`, but the fill supplies `string` (in code grafted by the fill for `#helpers`).``

A hole the template author wrote directly has no origin: `origin: null`, no suffix.

- [ ] **Step 1: Write the failing unit tests**

In `lib/runtime/template/fill.test.ts` (reuse its existing template/filler helpers):

```ts
describe("origin attribution", () => {
  it("a type error on a grafted hole names the graft it arrived through", () => {
    const guardTpl = loadFromString(
      `def guarded(): string {\n  const ms: number = #minutes\n  const r = guard(time: ms) {\n    #body\n  }\n  return "done"\n}\n`,
    );
    const mainTpl = loadFromString(`#helpers\n\nnode main(): string {\n  return guarded()\n}\n`);
    const body = parseStatementsHelper(`print(1)`);
    const partial = fillHoles(guardTpl, { body });
    const program = fillHoles(mainTpl, { helpers: partial });
    expect(() => fillHoles(program, { minutes: "two" })).toThrow(
      /in code grafted by the fill for `#helpers`/,
    );
  });

  it("an author-written hole gets no origin suffix", () => {
    const tpl = loadFromString(`node main() {\n  const x: number = #count\n}\n`);
    expect(() => fillHoles(tpl, { count: "two" })).toThrow(/expects `number`/);
    expect(() => fillHoles(tpl, { count: "two" })).not.toThrow(/grafted by the fill/);
  });

  it("the unknown-name error annotates grafted holes with their origin", () => {
    const inner = loadFromString(`node main() {\n  const x: number = #minutes\n}\n`);
    const outer = loadFromString(`#helpers\n`);
    const program = fillHoles(outer, { helpers: inner });
    expect(() => fillHoles(program, { nope: 1 })).toThrow(
      /#minutes \(from the fill for `#helpers`\)/,
    );
  });
});
```

In `lib/stdlib/template.test.ts`:

```ts
it("holesOf reports which graft contributed each remaining hole", () => {
  const inner = _loadTemplateFromString(`node main() {\n  const x: number = #minutes\n}\n`);
  const outer = _loadTemplateFromString(`#helpers\n\n#direct\n`);
  const program = _fill(outer, { helpers: inner });
  const infos = _holesOf(program);
  const minutes = infos.find((info) => info.name === "minutes");
  const direct = infos.find((info) => info.name === "direct");
  expect(minutes?.origin).toBe("helpers");
  expect(direct?.origin).toBe(null);
});
```

(Match the test file's existing import style. If the first test's guard-template snippet fails to parse — e.g. `guard` inside a `def` needs different framing — simplify the guard away: the origin machinery under test only needs the annotated assignment and the `#body` statements hole; the guard block is narrative, not load-bearing.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:run lib/runtime/template/fill.test.ts lib/stdlib/template.test.ts > /tmp/claude-t3-red.log 2>&1; tail -40 /tmp/claude-t3-red.log`
Expected: FAIL — no origin suffix in messages, no `origin` field on `HoleInfo`.

- [ ] **Step 3: Implement the origin suffix in fill.ts**

Add near the top of `lib/runtime/template/fill.ts`:

```ts
/** Attribution for errors that anchor to a node carried in by a graft:
 *  its loc.origin (stamped by stampOrigin) names the fill the node most
 *  recently arrived through — re-grafting overwrites the stamp, so in a
 *  nested composition the OUTERMOST graft wins, which is the one the
 *  current caller performed and can act on. Best-effort: loc-less inner
 *  nodes carry no stamp and get no suffix. Only the fill path can read
 *  this — toSource/runCode re-parse from text, which drops loc entirely;
 *  compile-side attribution needs the fragment-checker entry point
 *  (recorded follow-up). */
function originSuffix(loc: SourceLocation | undefined): string {
  if (!loc?.origin || loc.origin.kind !== "filler") return "";
  return ` (in code grafted by the fill for \`#${loc.origin.name}\`)`;
}
```

Then append `${originSuffix(hole.loc)}` to every error message that anchors to a hole:

- `assertFillerType` — and delete its existing hardcoded tail `` (in the fill for `#${hole.name}`) ``, which redundantly repeats the hole's own name (the message already leads with it; that string appears nowhere else in the repo and no test asserts it — `fill.ts:195` is its only occurrence). New message: `` `The hole \`#${hole.name}\` expects \`${expectedType}\`, but the fill supplies \`${actual}\`${originSuffix(hole.loc)}.` ``
- `assertKindMatchesSort`, the splice-needs-array error, the expr-arity error in `fillOne`, and all three rejections in `identifierFillFor` — same pattern, `originSuffix(hole.loc)` before the closing period.
- `substituteAny`'s single-item arity error — it holds the hole as `value`; use `originSuffix(value.loc)`.

For the unknown-name error in `fillHoles`, annotate the listed holes. Replace the `present`-based check body:

```ts
const holes = findHoles(code.nodes);
const present = holeNames(code.nodes);
for (const name of Object.keys(values)) {
  if (!present.includes(name)) {
    const listed = present
      .map((holeName) => {
        const hole = holes.find((candidate) => candidate.name === holeName) as Hole;
        const origin = hole.loc?.origin;
        return origin && origin.kind === "filler"
          ? `#${holeName} (from the fill for \`#${origin.name}\`)`
          : `#${holeName}`;
      })
      .join(", ");
    throw new Error(
      `\`${name}\` is not a hole in this template. Its holes are: ${listed || "(none)"}.`,
    );
  }
}
```

Import `findHoles` alongside the existing `holeNames` import from `../../utils/holes.js`. Note the existing message printed bare names without `#`; the annotated form adds the sigil — check for tests asserting the old exact text (`grep -rn "is not a hole in this template" lib/`) and update them.

- [ ] **Step 4: Add `origin` to `HoleInfo`**

In `lib/utils/holes.ts`, extend the type and `holeInfos`:

```ts
export type HoleInfo = {
  name: string;
  sort: HoleSort;
  splice: boolean;
  /** The hole's printed type ("number", "string[] | null"), or null when no
   *  type applies (statements/decl/identifier holes) or none is known. */
  type: string | null;
  /** When this hole arrived inside a grafted fragment: the name of the hole
   *  that fragment was most recently filled into (loc.origin, stamped by
   *  fill; re-grafting overwrites, so the outermost graft wins). Null for
   *  holes written directly in the template, and best-effort null when the
   *  hole node carries no loc. */
  origin: string | null;
};
```

And in the object `holeInfos` returns, after `type`:

```ts
origin: hole.loc?.origin?.kind === "filler" ? hole.loc.origin.name : null,
```

(First-occurrence-wins already governs which `hole` object is read — same rule as `sort` and `splice`; the doc comment on `positionInferredTypes` explains the policy.)

- [ ] **Step 5: Mirror the field on the Agency side and rebuild**

In `stdlib/agency.agency`, find the `HoleInfo` type and add:

```
  origin: string | null
```

In `holesOf`'s doc comment/docstring, add one plain sentence: `origin` names the fill this hole most recently arrived through when it came in via a grafted fragment (best-effort — null for holes written directly in the template or when position data is missing). Then:

Run: `make > /tmp/claude-t3-make.log 2>&1; tail -5 /tmp/claude-t3-make.log` — must succeed (stdlib change).
Run: `make doc > /tmp/claude-t3-makedoc.log 2>&1; tail -5 /tmp/claude-t3-makedoc.log` — regenerates the stdlib reference page.

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `pnpm test:run lib/runtime/template/fill.test.ts lib/stdlib/template.test.ts lib/utils/ > /tmp/claude-t3-green.log 2>&1; tail -20 /tmp/claude-t3-green.log`
Expected: PASS.

- [ ] **Step 7: One execution fixture proving origin crosses the agency boundary**

`loadTemplateFromString` is **not** an Agency-side export — the exports are `loadTemplate(dir, filename)` (`stdlib/agency.agency:496`), `holesOf` (510), `fill` (519), `toSource` (529), `parseExpr` (538), `parseStatements` (547). So the fixture uses sibling template files, exactly like `tests/agency/templates/composeGuarded.agency` — read that fixture first and copy its conventions (loading, `isFailure(x)` spelling, how expectations are declared).

Create `tests/agency/templates/holesOfOriginInner.agency`:

```
node main() {
  const x: number = #minutes
}
```

Create `tests/agency/templates/holesOfOriginOuter.agency`:

```
#helpers
```

Create `tests/agency/templates/holesOfOrigin.agency` (adjust to the real conventions; the assertions are the substance):

```
import { loadTemplate, fill, holesOf } from "std::agency"

node main(): string {
  const inner = loadTemplate(__dirname, "holesOfOriginInner.agency")
  if (isFailure(inner)) {
    return "inner load failed"
  }
  const outer = loadTemplate(__dirname, "holesOfOriginOuter.agency")
  if (isFailure(outer)) {
    return "outer load failed"
  }
  const program = fill(outer.value, { helpers: inner.value })
  if (isFailure(program)) {
    return "fill failed"
  }
  const holes = holesOf(program.value)
  if (holes[0] == null) {
    return "no holes"
  }
  if (holes[0].origin == "helpers") {
    return "origin-ok"
  }
  return "origin missing"
}
```

Check how the two sibling template files interact with the test runner (a file whose `main` contains an unfilled hole may itself be picked up as a failing test — see how composeGuarded's siblings avoid that; follow the same convention, e.g. naming or directory placement). Verify the driver parses: `pnpm run ast tests/agency/templates/holesOfOrigin.agency > /tmp/claude-t3-ast.log 2>&1`. Then run just this test:

Run: `pnpm run agency test tests/agency/templates/holesOfOrigin.agency > /tmp/claude-t3-agencytest.log 2>&1; tail -20 /tmp/claude-t3-agencytest.log`
Expected: PASS with `origin-ok`. No LLM calls involved.

- [ ] **Step 8: Update the two docs**

`docs/site/guide/templates.md`:
- The `holesOf` example (line ~39): add `origin: null` to both entries and one sentence after the code block: holes that arrived inside a grafted fragment instead carry the name of the hole they most recently came through — see the composition section.
- The composition section (line ~123): extend the example's `holesOf(program.value)` comment to `// [{ name: "minutes", origin: "helpers", ... }]` and add: errors from a later fill say the same thing, e.g. `` …expects `number` … (in code grafted by the fill for `#helpers`) ``. Word it as "most recently arrived through" — in a deeper composition each re-graft re-stamps, so the outermost graft is the one reported.

`docs/dev/template-agency.md`: find the origin-attribution section (it describes the stamps as written-but-unread); update it to name the two readers (fill-path error suffix, `HoleInfo.origin`), the outermost-wins overwrite semantics, the best-effort boundary (loc-less inner nodes), and keep the recorded limitation: compile-side attribution is impossible until an AST-in compile entry point exists, because `toSource` → re-parse drops `loc`.

- [ ] **Step 9: Full verification and commit**

Run: `pnpm test:run > /tmp/claude-t3-final.log 2>&1; tail -5 /tmp/claude-t3-final.log` — all pass.
Run: `pnpm run lint:structure` — clean.

```bash
git add lib/runtime/template/fill.ts lib/utils/holes.ts lib/runtime/template/fill.test.ts lib/stdlib/template.test.ts stdlib/agency.agency tests/agency/templates/ docs/site/ docs/dev/template-agency.md
git status   # verify only intended files; docs/site regeneration from make doc is expected
printf 'Fill errors and holesOf read loc.origin\n\nfill deep-stamps loc.origin on grafted nodes but nothing read it. Fill\npath errors now append which graft a node most recently arrived through\n(re-grafting overwrites, outermost wins), and HoleInfo gains origin so a\nmodel composing templates can see which sub-template each remaining hole\ncame from. Best-effort by design; compile-side attribution stays\nimpossible until an AST-in compile entry point exists (toSource re-parse\ndrops loc).\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude-commit-t3.txt
git commit -F /tmp/claude-commit-t3.txt
```

---

### Task 4: Follow-up issue and PR

- [ ] **Step 1: File the walker-gaps follow-up issue** — one issue listing every `KNOWN_WALKER_GAPS` entry Task 1 produced, with: the field, what expressions it holds, why fixing it is a compiler change (scope resolution → codegen surface), and a pointer to the staleness guard that will force the entry's deletion. Body written to a file, created with `gh issue create --body-file`. Then backfill the issue number into the `KNOWN_WALKER_GAPS` entries and commit that small change. If Task 1 produced no gap entries, skip this step and say so in the PR.

- [ ] **Step 2: Anti-pattern audit** — read `docs/dev/anti-patterns.md` and check the full branch diff (`git diff origin/main...HEAD`) against it. Fix anything found before pushing.

- [ ] **Step 3: Push and open the PR** — write the body to a file first. It must cover: the three gaps in one paragraph each (reuse this plan's Background framing); the no-walker-changes policy and the `KNOWN_WALKER_GAPS` + staleness-guard mechanism (with the follow-up issue link); every `WALKER_EXCLUDED_FIELDS` ruling added; the `Set`-for-identity-membership deviation and why; the finding-8 scope ruling (comprehension binders in, result-pattern/match-arm binders documented out); the outermost-wins and best-effort origin semantics; and the compile-side origin boundary. End with the standard generated-with footer.

```bash
git push -u origin adit/template-agency-fixes
gh pr create --title "Template Agency follow-ups: walker tripwire, pattern-binder hygiene, origin-aware errors" --body-file /tmp/claude-pr-body.txt
```

CI runs the agency suite; do not run it locally.

---

## Self-review notes

- **Review findings applied:** 1 (fixture rewritten on `loadTemplate` + siblings + `isFailure`), 2 (worked example and test route `#minutes` through an annotated assignment; named-arg holes supply no expected type), 3 (dev doc arrives with merged #666 after fetch; Task 0 verifies), 4 (invariant A stated as consistency, B as reachability), 5 (exclusions keyed `ownerType.field`), 6 (memoized cache; unlowered-parse smoke check gates the task), 7+owner directive (no walker edits; `KNOWN_WALKER_GAPS` + staleness guard + follow-up issue), 8 (comprehension binders in scope — identical shape to forLoop; result-pattern/match-arm binders stay as narrowed documented limits), 9 (outermost-wins stated everywhere origin is described), 10 (best-effort stated in code comment, docstring, and dev doc). Smaller corrections: `expandShorthand` carries no `loc`; `formatObjectPattern` behavior stated as fact; `fill.ts:195` tail confirmed unreferenced; `patternBinders` comment names the dropped `resultPattern` binder.
- **Known unknowns an implementer will hit, called out in place:** exact hygiene/fill test helper names (Task 2 Step 1, Task 3 Step 1); whether the unlowered corpus parses at all (Task 1 Step 1 — gates half the task); comprehension/destructuring test-snippet spellings (verify with `pnpm run ast` before writing tests); how sibling template files coexist with the agency test runner (Task 3 Step 7).
- **Type consistency:** `HoleInfo.origin: string | null` used identically in Task 3 Steps 1, 4, 5, 7, 8. `patternBinders(pattern: BindingPattern): string[]` used identically in Task 2 Steps 3-4. `originSuffix(loc: SourceLocation | undefined): string` matches every call site. `KNOWN_WALKER_GAPS` / `WALKER_EXCLUDED_FIELDS` key format `"ownerType.field"` used identically in Task 1 Steps 3-5 and Task 4 Step 1.
- **Ordering:** Task 1 first so its recorded gaps are known before Task 2's hygiene tests are interpreted (a hygiene test that fails because of a *known walker gap* is a different diagnosis than a hygiene bug).
