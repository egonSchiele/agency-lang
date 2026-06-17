# Pluggable Optimizer Framework Design

**Date:** 2026-06-17
**Status:** Draft

## Summary

Generalize Agency's `optimize` pipeline from a single hard-coded search loop into a
**pluggable optimizer framework**. The framework lets Agency ship several built-in
optimization algorithms (starting with a reflective greedy optimizer and GEPA), and lets
users author new optimizers and new graders without touching the shared machinery.

The design follows DSPy's `Teleprompter` split: each optimizer owns its *search loop* and
private state; everything expensive or fiddly (workspace management, agent execution,
grading, source mutation, the JS↔Agency boundary) is a shared service the optimizer calls.

This is a design spec only. It does not change behavior on its own; it defines the
abstractions an implementation plan will build, in the phase order given under
"Implementation phasing."

## Background: what exists today (PR #283)

`agency eval optimize foo.agency --goal|--tasks` already runs a champion–challenger
hill-climb (`lib/optimize/loop.ts`):

- Optimize targets are declarations marked with the `optimize` modifier
  (e.g. `optimize const prompt = "..."`), discovered over the entry file's import tree.
- An LLM **mutator** proposes declarative source edits; `OptimizeSourceMutator` applies them
  via parse → AST replace → `AgencyGenerator` render (never source patching).
- Each candidate is run over a task suite (`evalRunLoadedTasks`), then `judgeSuite` compares
  champion vs candidate **pairwise** and accepts the candidate iff `winner === "B"`.
- Iteration history (rationale + win/loss + loss reasons) is fed back to the mutator.

Invariants to preserve (from PR #283 review):

- **Parse budget:** O(closure) once at startup + O(files touched) per preview. Never
  re-discover or re-parse unchanged files mid-loop.
- The prompt skeleton lives only in the mutator's `.agency` file; TS renders data sections
  and zod-validates the JS↔Agency boundary. Do not reintroduce a TS prompt copy.
- Mutations are applied AST-first; diffs are informational only.
- Multi-file writeback is sha-checked: a single external modification aborts writeback.

The current loop is essentially a degenerate reflective optimizer. This spec keeps that
behavior available as one strategy (`greedy`) and adds the seams needed for others.

## Terminology

| Term | Meaning | Prior art |
|---|---|---|
| **Input** | One invocation of the agent: `{ node?, args, metadata? }`. The unit the agent runs on. | `dspy.Example`; OpenAI eval "item" |
| **Grader** | A class that reads an agent run and produces a `Grade`. Replaces "metric". | OpenAI "graders" |
| **Grade** | A grader's output: a `Score` (binary or scalar) plus optional natural-language `feedback`. | DSPy `ScoreWithFeedback` |
| **Optimizer** | A search strategy that mutates optimize targets to improve grades. | DSPy `Teleprompter` |

"Grader" is chosen over DSPy's "metric": OpenAI's Evals and reinforcement-fine-tuning APIs
use "grader" as a first-class concept (`string_check`, `text_similarity`, `score_model`,
`python`, `multi`), DSPy does not use the word for anything else (so there is no collision),
and `Grader → Grade` reads consistently.

## Architecture: three layers, one boundary

```
Layer A — INPUTS:     what the agent runs on        → ONE AgentRun per (input, workspace)
   ───────────────── dedup boundary: runs produced ONCE, here ─────────────────
Layer B — GRADERS:    criteria that read those runs → Grades (never re-run the agent)
Layer C — OPTIMIZER:  consumes grades + traces      → decides the next mutation
```

The boundary between A and B is the core efficiency guarantee: an agent run is expensive and
**shared**; a grade is cheap and **plural**. The agent runs once per input per workspace
(memoized by the eval cache); every grader that touches that input reads the same run.

```
┌─ Layer 3: OPTIMIZERS (pluggable brains) ─────────────────┐
│  GreedyReflective   Gepa   <future: Miprov2, …>          │
└───────────────────────────────────────────────────────────┘
        │ each implements  optimize(target)
        ▼
┌─ Layer 2: CONTRACTS (new, small) ────────────────────────┐
│  Input · Grader/Grade · Scorecard · Mutation             │
└───────────────────────────────────────────────────────────┘
        │ built on
        ▼
┌─ Layer 1: SHARED SERVICES ───────────────────────────────┐
│  WorkspaceManager · AgencyRunner · EvalCache ·           │
│  target discovery + OptimizeSourceMutator (PR #283) ·     │
│  artifacts/reporter (PR #283)                             │
└───────────────────────────────────────────────────────────┘
```

Layer 1 is mostly what PR #283 shipped, plus two new services (`WorkspaceManager`,
`EvalCache`). Layer 3 is where new algorithms live. Layer 2 is the new contract code and is
deliberately small.

## Core types

```ts
type Input = {
  id?: string;        // optional; auto-derived (index / hash of args) if omitted
  node?: string;      // defaults to "main"
  args: Json;
  metadata?: Json;    // freeform, grader-agnostic: title, note, expectedOutput, tags, …
};

type Grade = { score: Score; feedback?: string };

type Score =
  | { kind: "binary"; pass: boolean }
  | { kind: "scalar"; value: number };

type GraderOptions = {
  mustPass?: boolean;            // gate: failure fails the whole iteration for this input
  threshold?: number;            // scalar passing bar (binary reads `pass`)
  weight?: number;               // contribution to the scalarized objective (default 1)
  samples?: number;              // k repetitions (default 1)
  aggregate?: "any" | "all";     // binary only; scalar always averages
  inputScope?: GraderScope;      // restrict to a subset of inputs (default: all)
  name?: string;                 // overrides the grader's defaultName (used by generic built-ins)
};

// Grader subclasses extend GraderOptions with their own fields, e.g. ExactMatchGrader's
// `matchOn: JsonPath`, LlmJudge's `agencyFile: string`, HumanGrader's `scale: { min, max }`.

type GraderScope = { tag: string } | { ids: string[] };

type GraderInput = {
  input: Input;
  run: AgentRun;                 // produced ONCE per (input, workspace); shared across graders
  runAgency: AgencyRunner;       // capability to invoke a judge .agency file
  requestHumanReview: HumanReviewFn; // always present; rejects with a clear error if no human provider is bound
};

type AgentRun = {
  output: Json;                  // the agent's return value
  recordPath: string;           // path to the full execution trace (evalRecordPath); not held in memory
};
```

`metadata` carries zero grader awareness; graders declare their own data dependency via a
path selector in their options (e.g. `matchOn: ["metadata", "expectedOutput"]`). The only
coupling between an input and a grader is that one-directional, explicit path.

## Graders

### `BaseGrader`

A grader author writes a single-shot `_run`; the base orchestrates sampling and aggregation
once, so the "how" lives in exactly one place.

```ts
abstract class BaseGrader {
  constructor(protected readonly options: GraderOptions = {}) {}

  /** Subclasses set a default; `options.name` overrides it. A getter avoids field init-order issues. */
  protected abstract readonly defaultName: string;
  get name(): string { return this.options.name ?? this.defaultName; }

  /** Single-shot grade. Declarative: no sampling, no aggregation. */
  protected abstract _run(input: GraderInput): Promise<Grade>;

  get isGate(): boolean { return this.options.mustPass ?? false; }
  get weight(): number { return this.options.weight ?? 1; }

  /** Whether this grader runs on `input`. Default (no inputScope) → every input. */
  gradesInput(input: Input): boolean {
    const scope = this.options.inputScope;
    if (!scope) return true;
    if ("tag" in scope) return (input.metadata?.tags ?? []).includes(scope.tag);
    return scope.ids.includes(input.id);
  }

  /** Orchestration: run `_run` k times, aggregate by score kind. */
  async run(input: GraderInput): Promise<Grade> {
    const samples = this.options.samples ?? 1;
    const trials = await Promise.all(
      Array.from({ length: samples }, () => this._run(input)),
    );
    return aggregateGrades(trials, this.options.aggregate ?? "all");
  }

  passes(grade: Grade): boolean {
    if (grade.score.kind === "binary") return grade.score.pass;
    return grade.score.value >= (this.options.threshold ?? 0);
  }
}
```

`aggregateGrades` is pure: scalar trials average; binary trials use `some`/`every` for
`any`/`all`; feedback is concatenated. The `k` repetitions re-invoke `_run` with the same
`run` (the agent output is fixed) — for an LLM judge, only the judge varies, not the agent.
Deterministic graders set `samples: 1` and the loop is a no-op.

### Three grader kinds (all the same shape)

1. **Deterministic** — pure TS / runs an `.agency` checker; e.g. `ExactMatchGrader`,
   `SimilarityGrader`. Decompose multi-concern checks: "the code is correct" becomes a
   `CompilesGate` (binary, `mustPass`) plus a `CorrectnessGrader` (scalar). One concern per
   grader; the gate falls out of the `mustPass` flag.
2. **LLM judge** — a shipped built-in `LlmJudge` configured with a judge `.agency` file path;
   no class to write. Runs the judge via `runAgency`, reads back `{ pass | score, reasoning }`.
3. **Human** — pauses the **optimization loop** (not the agent) with ordinary async TS via a
   harness-provided human-input capability. See "Human grading" below.

### Built-in graders

Agency ships graders mirroring OpenAI's taxonomy:

- `ExactMatchGrader` (`matchOn` path → binary)
- `ContainsGrader` / `RegexGrader` (binary)
- `SimilarityGrader` (scalar)
- `LlmJudge` (`score_model` analog; binary or scalar)
- `HumanGrader` (scalar or binary)

Users subclass `BaseGrader` for anything custom.

### Human grading

Graders are **TypeScript**, so a human grader does **not** use Agency's interrupt/handler
system (that system is for the agent under test pausing mid-execution). The human grader runs
*after* the agent run completes and pauses the optimization loop with `await
requestHumanReview(...)` against a human-input capability the harness injects (a terminal
prompt, or a web callback), exactly the way `runAgency` is injected.

```ts
class HumanGrader extends BaseGrader {
  protected async _run({ input, run, requestHumanReview }: GraderInput): Promise<Grade> {
    const review = await requestHumanReview({
      prompt: `Rate the declarative quality (1–${this.scale.max}):`,
      artifact: run.output,
      scale: this.scale,
    });
    return { score: { kind: "scalar", value: review.rating / this.scale.max }, feedback: review.note };
  }
}
```

Two consequences:

- **Gate ordering protects the human.** Gates run first and short-circuit, so a human is only
  asked to review a run that already cleared the cheap deterministic gates (e.g. it compiles).
- **No human provider ⇒ fail fast.** In a non-interactive context (CI), the harness has no
  human-input capability bound. A run that reaches a human grader there must error with a
  clear message, never block.

`requestHumanReview` is supplied on `GraderInput` alongside `runAgency` so a half-constructed
grader is impossible (no post-construction binding of mutable capabilities).

## Grading: run once, grade many

```ts
type GraderGrade = { grader: BaseGrader; grade: Grade };
type InputGrades = { input: Input; run: AgentRun; grades: GraderGrade[]; gatesPassed: boolean };
```

`InputGrades` retains `run` (the trace reference) so trace-consuming optimizers (GEPA) can
reflect on it. The trace is referenced by `recordPath`, not inflated into memory.

```ts
class Scorecard {
  constructor(readonly perInput: InputGrades[]) {}

  get gatesPassed(): boolean { return this.perInput.every(i => i.gatesPassed); }

  /** Gate-failed inputs score 0 — they lose every frontier slot and drag the mean down. */
  get inputScores(): number[] {
    return this.perInput.map(i => (i.gatesPassed ? inputObjective(i.grades) : 0));
  }

  get objective(): number { return mean(this.inputScores); }

  /** Trace-consuming optimizers read `perInput` directly (grades + `run.recordPath` per input). */
}

function inputObjective(grades: GraderGrade[]): number {
  const contributions = grades
    .filter(g => !g.grader.isGate)
    .flatMap(g =>
      g.grade.score.kind === "scalar"
        ? [{ weight: g.grader.weight, value: g.grade.score.value }]
        : [],
    );
  const totalWeight = sum(contributions.map(c => c.weight));
  if (totalWeight === 0) return 0;
  return sum(contributions.map(c => c.weight * c.value)) / totalWeight;
}
```

Gates are filtered out of the objective (they are filters, not contributors). `objective`
derives from the gate-aware `inputScores` vector, so greedy reads `.objective`/`.gatesPassed`
and GEPA reads the `.inputScores` vector — same scorecard, no special-casing.

## `BaseOptimizer`

`BaseOptimizer` is generic over its config type, so each optimizer reads its own
algorithm-specific knobs without polluting a shared config.

```ts
abstract class BaseOptimizer<C extends BaseOptimizerConfig> {
  protected readonly workspace: WorkspaceManager;   // composed, injected with a default
  protected readonly history: HistoryEntry[] = [];
  protected abstract readonly mutatorAgent: string; // proposer .agency file, alongside the class

  constructor(protected readonly config: C) {
    this.workspace = config.workspace ?? new WorkspaceManager();
  }

  /** Subclasses implement ONLY their search policy. */
  abstract optimize(target: OptimizeTarget): Promise<OptimizeResult>;

  protected get graders(): BaseGrader[] { return this.config.graders; }
  protected get gates(): BaseGrader[] { return this.graders.filter(g => g.isGate); }
  protected get advisory(): BaseGrader[] { return this.graders.filter(g => !g.isGate); }

  /** Discover once, over the original files (respects the O(closure)-once parse budget). */
  protected discoverTargets(target: OptimizeTarget): DiscoveredSource { /* PR #283 discovery */ }
  // DiscoveredSource = { targets: Target[]; root: WorkspaceRef } — `root` is the dir baselines fork from.

  /** Run the agent ONCE per input, grade with every grader that applies, return a Scorecard. */
  protected async evaluate(ws: Workspace, inputs: Input[]): Promise<Scorecard> {
    const perInput = await Promise.all(inputs.map(input => this.gradeInput(ws, input)));
    return new Scorecard(perInput);
  }

  private async gradeInput(ws: Workspace, input: Input): Promise<InputGrades> {
    const run = await this.workspace.run(ws, input);           // single rollout, eval-cached
    const gateResult = await this.runGates(run, input);
    if (!gateResult.passed) {
      return { input, run, grades: gateResult.grades, gatesPassed: false }; // skip advisory
    }
    const advisory = await this.gradeAll(this.advisory.filter(g => g.gradesInput(input)), run, input);
    return { input, run, grades: [...gateResult.grades, ...advisory], gatesPassed: true };
  }

  /** The one place sequential short-circuiting lives — encapsulated, named, contained. */
  private async runGates(run: AgentRun, input: Input): Promise<{ grades: GraderGrade[]; passed: boolean }> {
    const grades: GraderGrade[] = [];
    for (const grader of this.gates.filter(g => g.gradesInput(input))) {  // cheap/deterministic gates first
      const grade = await grader.run(this.graderInput(input, run));
      grades.push({ grader, grade });
      if (!grader.passes(grade)) return { grades, passed: false }; // bail before the LLM/human grader
    }
    return { grades, passed: true };
  }

  /** Advisory graders run in parallel (no short-circuit needed once gates have passed). */
  private gradeAll(graders: BaseGrader[], run: AgentRun, input: Input): Promise<GraderGrade[]> {
    return Promise.all(
      graders.map(async grader => ({ grader, grade: await grader.run(this.graderInput(input, run)) })),
    );
  }

  private graderInput(input: Input, run: AgentRun): GraderInput {
    // Fallback rejects with a clear error, so a human grader in CI fails fast instead of hanging.
    return {
      input,
      run,
      runAgency: this.workspace.runAgency,
      requestHumanReview: this.config.requestHumanReview ?? rejectNoHumanProvider,
    };
  }

  /** JS↔Agency boundary: run the proposer .agency file, zod-validate its structured output. */
  protected propose(context: ProposalContext): Promise<Mutation> {
    return this.workspace.runAgency.structured(this.mutatorAgent, context, MutationSchema);
  }

  protected async eachIteration(step: (iter: number) => Promise<void>): Promise<void> {
    for (let iter = 1; iter <= this.config.iterations; iter++) await step(iter);
  }
}
```

`grader.gradesInput(input)` decides whether a grader runs on an input (default: all). `runGates` is the single
contained imperative loop; its sequential order is required by the short-circuit, which the
anti-patterns catalog explicitly exempts. Every method a subclass touches is a declarative
call.

### Construction vs. target (DSPy split)

Graders + policy construct the optimizer; the agent + inputs are the target passed to
`optimize()`. The optimizer instance is reusable across agents and input sets.

```ts
// Cross-cutting fields every optimizer needs (the base methods read these).
type BaseOptimizerConfig = {
  graders: BaseGrader[];
  iterations: number;                 // generic loop budget; an optimizer may reinterpret it
  seed?: number;                      // seeds the RNG for reproducible sampling
  workspace?: WorkspaceManager;       // injected for tests
  requestHumanReview?: HumanReviewFn; // bound in interactive contexts; absent ⇒ human graders fail fast
};

// Each optimizer extends the base with its own knobs. Greedy adds nothing; GEPA adds minibatching.
type GreedyConfig = BaseOptimizerConfig;
type GepaConfig = BaseOptimizerConfig & {
  minibatch: number;       // inputs sampled per iteration for the cheap filter
  paretoSet?: Input[];     // the fixed set frontier scores are compared on (default: all inputs)
};

type OptimizeTarget = {
  agent: string;      // file[:node]; optimize targets discovered in its import tree
  inputs: Input[];
};
```

`class GreedyReflective extends BaseOptimizer<GreedyConfig>` and
`class Gepa extends BaseOptimizer<GepaConfig>`; `Gepa` reads `this.config.minibatch`, which
simply does not exist on the greedy side.

## The JS↔Agency boundary

Proposing and judging cross into Agency the same way — one runner method that
**zod-validates the structured return** (the established PR #283 pattern):

```ts
type AgencyRunner = {
  run(ws: Workspace, input: Input): Promise<AgentRun>;                       // agent under test
  structured<T>(agencyFile: string, input: Json, schema: ZodSchema<T>): Promise<T>; // judge / proposer
};

const MutationSchema = z.object({
  rationale: z.string(),
  operations: z.array(MutationOpSchema),   // the PR #283 declarative ops — reused, not reinvented
});
type Mutation = z.infer<typeof MutationSchema>;
```

`structured` resolves the `.agency` file path **relative to the calling class's module**, so
judge/proposer files live next to their grader/optimizer and are **never copied into a
workspace**. The proposer file's `main(targets, history, …)` returns `{ rationale, operations }`;
a judge file's `main(...)` returns `{ pass | score, reasoning }`.

### How an `.agency` file actually runs

Both methods drive the existing compile-and-run pipeline
(`parse → SymbolTable.build → buildCompilationUnit → preprocess → TypeScriptBuilder → printTs`),
then execute the generated program on the SimpleMachine engine. They differ only in *which*
program runs, *where*, and *what comes back*:

**`run(ws, input)` — the agent under test.** Resolves `input.node` (default `main`) in the
agent file *inside the workspace `ws`*, invokes it with `input.args`, and runs it as a full
Agency program — its own handlers, interrupts, and tool calls intact. This wraps the existing
`evalRunLoadedTasks` machinery, so it inherits eval-record writing. It returns
`AgentRun = { output, recordPath }`: `output` is the node's return value (deserialized to
`Json`), `recordPath` points at the on-disk trace (the existing `evalRecordPath`). The call is
memoized through `EvalCache` on `(workspaceHash, input.id)` — this is the single place the
agent is ever run, and the source of the "run once, grade many" guarantee.

**`structured(agencyFile, input, schema)` — a judge or proposer.** Compiles and runs an
`.agency` file that lives *next to the TS class* (resolved via the module URL), not in any
workspace. `input` is passed as the node's arguments; the node's return is an Agency
structured-output value, serialized to JSON and **zod-validated against `schema`** before it
re-enters TS. A validation failure is a hard error (the model returned a malformed proposal),
surfaced to the optimizer; the greedy/GEPA loops already treat a failed proposal as a skipped
iteration. This is the exact PR #283 boundary contract (the `.agency` file owns the prompt
skeleton; TS renders data sections and validates the return) generalized from one mutator to
"any judge or proposer."

**Determinism in tests.** Because both paths execute real Agency programs, LLM calls inside
the agent *and* inside judges/proposers are intercepted by the repo's scoped
`AGENCY_LLM_MOCKS` (keyed by module id), so a full optimizer iteration runs with no live LLM
calls. The agent-vs-judge separation matters here: a test can mock the agent's output and the
judge's verdict independently.

## WorkspaceManager

Names and owns what `loop.ts` already does on disk (`writeIterationWorkspace`, `iter-N/`):

```ts
class WorkspaceManager {
  fork(from: WorkspaceRef): Workspace;             // copy a dir into a fresh iteration workspace
  run(ws: Workspace, input: Input): Promise<AgentRun>;  // run the agent in ws; eval-cached
  read(ws: Workspace, relPath: string): string;
  write(ws: Workspace, relPath: string, content: string): void;
  applyMutation(ws: Workspace, mutation: Mutation): void;  // delegates to OptimizeSourceMutator
  runAgency: AgencyRunner;
}
```

It also owns **path resolution**: callers pass a path relative to the agent, and the manager
resolves it against the active workspace. `applyMutation` delegates to `OptimizeSourceMutator`
(parse → AST replace → render), preserving the parse-budget invariant.

## EvalCache

A shared service keyed by `(workspaceHash, inputId)` returning a cached `AgentRun`. Two
reasons it is load-bearing, not optional:

- Multiple graders read the same input's run — the cache enforces "run once, grade many".
- GEPA re-grades a *parent* candidate on each minibatch to compare against the child on the
  same batch; without the cache this roughly doubles minibatch rollouts. Rollouts are the
  expensive thing, so the cache is what makes GEPA's sample-efficiency claim hold.

This is why inputs need a **stable id**: the cache key and GEPA's per-input frontier vector
both depend on it. `id` is optional in the API and auto-derived (index, or hash of `args`)
when omitted.

## Built-in optimizer: GreedyReflective

The re-homed PR #283 loop, reduced to pure policy.

```ts
class GreedyReflective extends BaseOptimizer<GreedyConfig> {
  protected readonly mutatorAgent = "./greedy-mutator.agency";

  async optimize(target: OptimizeTarget): Promise<OptimizeResult> {
    const source = this.discoverTargets(target);
    const baseline = this.workspace.fork(source.root);
    let champion: Champion = { ws: baseline, scorecard: await this.evaluate(baseline, target.inputs) };
    this.requireBaselinePasses(champion.scorecard);

    await this.eachIteration(async (iter) => {
      const candidate = this.workspace.fork(champion.ws);     // always fork the CHAMPION
      const mutation = await this.propose({ targets: this.readTargets(candidate), history: this.history });
      this.workspace.applyMutation(candidate, mutation);
      const scorecard = await this.evaluate(candidate, target.inputs);
      this.history.push({ iter, mutation, scorecard });
      if (this.beats(scorecard, champion.scorecard)) champion = { ws: candidate, scorecard };
    });

    return this.finish(champion);                              // writeback + OptimizeResult
  }

  /** Greedy's entire policy. */
  private beats(candidate: Scorecard, champion: Scorecard): boolean {
    return candidate.gatesPassed && candidate.objective > champion.objective;
  }
}
```

**Behavior-change note:** PR #283 judges *pairwise* (`judgeSuite`, winner A/B); this framework
standardizes on *pointwise* graders. Re-homing greedy onto pointwise scoring is a deliberate
behavior change (it is what GEPA and future Bayesian optimizers also need). Pairwise
comparison, if still wanted, can be expressed as a grader that internally runs a two-input
judge. See "Implementation phasing" for how to stage this safely.

## Built-in optimizer: GEPA

Reflective evolution with a Pareto candidate pool. Reuses every shared service; only the loop
body and policy differ.

```ts
class Gepa extends BaseOptimizer<GepaConfig> {
  protected readonly mutatorAgent = "./gepa-reflect.agency";   // a reflective proposer

  async optimize(target: OptimizeTarget): Promise<OptimizeResult> {
    const source = this.discoverTargets(target);
    const baseline = await this.admit(this.workspace.fork(source.root), target.inputs);
    this.requireBaselinePasses(baseline.scorecard);
    const pool = new CandidatePool([baseline]);

    await this.eachIteration(async (iter) => {
      const minibatch = this.sampleMinibatch(target.inputs);
      const parent = pool.frontier().sample(this.rng);          // Pareto parent selection

      const child = this.workspace.fork(parent.ws);
      const mutation = await this.propose(this.reflectionContext(parent, minibatch));
      this.workspace.applyMutation(child, mutation);

      // cheap minibatch filter: promote only if the child beats its parent on the SAME batch
      const childMini = await this.evaluate(child, minibatch);
      const parentMini = await this.evaluate(parent.ws, minibatch);   // eval-cache → mostly hits
      if (!this.improves(childMini, parentMini)) {
        this.history.push({ iter, mutation, scorecard: childMini, admitted: false });
        return;
      }

      pool.add(await this.admit(child, target.inputs));         // full Pareto-set eval, then pool
      this.history.push({ iter, mutation, scorecard: pool.latest.scorecard, admitted: true });
    });

    return this.finish(pool.best());
  }

  /** Score on the fixed Pareto set (consistent across pool members) and wrap as a candidate. */
  private async admit(ws: Workspace, inputs: Input[]): Promise<Candidate> {
    return { ws, scorecard: await this.evaluate(ws, inputs) };
  }

  private improves(child: Scorecard, parent: Scorecard): boolean {
    return child.gatesPassed && child.objective > parent.objective;
  }

  private reflectionContext(parent: Candidate, minibatch: Input[]): ProposalContext {
    const ids = new Set(minibatch.map(i => i.id));
    const focus = parent.scorecard.perInput                         // this iteration's batch,
      .filter(i => ids.has(i.input.id))                             // each carrying grades + feedback
      .sort((a, b) => inputObjective(a.grades) - inputObjective(b.grades)); // weakest first
    return { targets: this.readTargets(parent.ws), focus, history: this.history };
  }
}
```

The frontier math lives in value objects so `optimize()` stays declarative:

```ts
type Candidate = { ws: Workspace; scorecard: Scorecard };

class CandidatePool {
  constructor(private readonly candidates: Candidate[]) {}
  add(c: Candidate): void { this.candidates.push(c); }
  get latest(): Candidate { return this.candidates.at(-1)!; }
  best(): Candidate { return maxBy(this.candidates, c => c.scorecard.objective); }
  frontier(): ParetoFrontier { return new ParetoFrontier(this.candidates); }
}

class ParetoFrontier {
  constructor(private readonly pool: Candidate[]) {}

  /** Candidates that achieve the best score on at least one input, with their win count. */
  private members(): { candidate: Candidate; wins: number }[] {
    const n = this.pool[0].scorecard.inputScores.length;
    const best = range(n).map(i => Math.max(...this.pool.map(c => c.scorecard.inputScores[i])));
    return this.pool
      .map(candidate => ({
        candidate,
        wins: range(n).filter(i => candidate.scorecard.inputScores[i] >= best[i]).length,
      }))
      .filter(m => m.wins > 0);
  }

  /** Sample a parent weighted by inputs won — preserves diversity, dodges local optima. */
  sample(rng: Rng): Candidate {
    return weightedPick(this.members().map(m => ({ item: m.candidate, weight: m.wins })), rng);
  }
}
```

Sampling uses a seeded RNG (`this.rng`, seeded from `config.seed`) for reproducible artifacts.

### Minibatching

GEPA works with **two input sets**, which is why `evaluate` takes an explicit set rather than
reading a fixed field:

- **The minibatch** — `config.minibatch` inputs sampled fresh each iteration from the full set
  (seeded RNG, without replacement). It is the *cheap filter*: the child mutation is scored on
  it, and so is its parent (re-graded on the *same* batch, mostly eval-cache hits). Only if the
  child beats its parent on that batch does GEPA pay for a full evaluation. A bad mutation is
  rejected after `minibatch` rollouts instead of a full-set run.
- **The Pareto set** — `config.paretoSet ?? target.inputs`, a *fixed* set every admitted
  candidate is scored on. Because it is the same for all candidates, their `inputScores`
  vectors are mutually comparable, which is what the frontier requires. (`admit` scores on this
  set.)

```ts
private sampleMinibatch(inputs: Input[]): Input[] {
  return sampleWithoutReplacement(inputs, this.config.minibatch, this.rng);
}
```

The minibatch never feeds the frontier — only the comparison filter. Mixing the two (scoring
candidate A on batch {1,2,3} and candidate B on {4,5,6}, then comparing their vectors) would
make frontier membership meaningless, so the separation is load-bearing, not an optimization.

### The Pareto frontier, worked

GEPA's frontier is **not** standard multi-objective Pareto dominance over full vectors. It is
the simpler, stronger-for-this-purpose notion from the GEPA paper: *a candidate is on the
frontier if it achieves the best score on at least one input.* Worked example — 3 inputs, a
pool of 3 candidates, each row an `inputScores` vector:

```
            input0   input1   input2     mean
  A          0.9      0.2      0.5        0.53
  B          0.3      0.8      0.5        0.53
  C          0.4      0.4      0.4        0.40
  best→      0.9(A)   0.8(B)   0.5(A,B)
```

- **A** is best on input0 (and ties on input2) → on the frontier, `wins = 2`.
- **B** is best on input1 (and ties on input2) → on the frontier, `wins = 2`.
- **C** is best on nothing → **excluded**, even though its mean (0.40) is respectable. It is a
  generalist dominated everywhere; mutating it is unlikely to discover anything the specialists
  haven't.

The payoff is what this does that a single-champion hill-climb cannot: it keeps **both A and
B**, complementary specialists (A is strong on input0, B on input1). Reflective mutation of A
can push input0 further; mutation of B can push input1 — two different weaknesses explored in
parallel across iterations, instead of collapsing to one winner and losing the other's
strategy. `>= best[i]` counts ties as wins for every tied candidate, deliberately, so tied
specialists are both retained. Sampling is weighted by `wins`, so a candidate that is best on
more inputs is mutated more often, but a one-input specialist still gets sampled and improved.
(This is also what a future system-aware *merge* would exploit — splicing A's input0 strength
into B's input1 strength.)

## User-facing interface

```ts
const gepa = new Gepa({
  graders: [
    new CompilesGate({ mustPass: true }),
    new CorrectnessGrader({ matchOn: ["metadata", "expectedOutput"], weight: 2 }),
    new LlmJudge({ name: "no-any", agencyFile: "./no-any.agency", mustPass: true, samples: 3, aggregate: "all" }),
    new HumanGrader({ name: "declarative", scale: { min: 1, max: 10 }, inputScope: { tag: "review" } }),
  ],
  iterations: 30,
  minibatch: 8,
});

const result = await gepa.optimize({
  agent: "code-generator.agency",
  inputs: [
    { id: "fizzbuzz", args: { spec: "Write FizzBuzz" }, metadata: { expectedOutput: fixture("fizzbuzz.agency"), tags: ["review"] } },
    { id: "parser",   args: { spec: "Write a JSON parser" } },
    { id: "router",   args: { spec: "Write an HTTP router" } },
  ],
});
```

Reads top to bottom as *what good means → how to search → the agent and the examples*.
Swapping `new Gepa(...)` for another optimizer changes only the search; graders and inputs are
untouched.

### CLI easy-start

The existing CLI stays the one-liner for the goal-only case (a single built-in LLM judge, no
custom graders), gaining one flag to pick the optimizer:

```bash
agency eval optimize code-generator.agency --goal "Generate correct Agency code" --optimizer gepa
```

Default `--optimizer greedy` preserves PR #283 behavior. The custom-grader path is inherently
programmatic, because deterministic and human graders *are code*.

### Optimizer registry

A registry maps name → factory so new optimizers register without touching the CLI or loop:

```ts
registerOptimizer("greedy", (cfg) => new GreedyReflective(cfg));
registerOptimizer("gepa",   (cfg) => new Gepa(cfg));
```

Adding a new optimizer touches only its own file + one registry line.

## Implementation phasing

1. **Extract the seam.** Introduce `BaseOptimizer` + registry; re-home the PR #283 loop as
   `greedy`, **keeping its pairwise `judgeSuite` internally** (zero behavior change). This
   proves the interface without a behavior shift.
2. **Pointwise graders + `BaseGrader` + `Scorecard` + `EvalCache`.** Add the built-in graders
   (`ExactMatchGrader`, `ContainsGrader`/`RegexGrader`, `SimilarityGrader`, `LlmJudge`).
   Migrate `greedy` to pointwise scoring (the behavior change, now isolated and reviewable).
3. **`WorkspaceManager` + `AgencyRunner.structured`** formalized as services (extracted from
   the existing artifact/run plumbing).
4. **`HumanGrader`** + harness human-input capability (terminal prompt; CI fail-fast).
5. **GEPA**: `CandidatePool`, `ParetoFrontier`, reflective proposer `.agency` file. Reuses all
   of the above; no new target domain.

## Non-goals

- **MIPROv2 and bootstrapped few-shot demos.** MIPROv2 needs (a) a TPE/Bayesian driver (no
  Optuna in TS — net-new) and (b) a **demo-set target kind**, i.e. a non-string optimize
  target (an array of examples spliced into the agent's message thread). Non-string optimize
  domains are an explicit non-goal of PR #283. Both are deferred; the framework is designed so
  MIPROv2 slots in later by overriding `optimize()` and adding the demo-set target domain,
  without disturbing graders or the run/grade boundary.
- **GEPA system-aware merge** (crossover of two lineages). Expressible later as `fork` +
  applying ops from two parents; out of scope for the first GEPA build.
- **Compile-time typing of the input-metadata ↔ grader `matchOn` link.** Validated at runtime
  (see Open questions) rather than via the type system.
- **Concurrency policy / sandbox isolation beyond per-iteration workspaces.**

## Open questions / known limitations

- **Stringly-typed `matchOn`.** A grader's metadata path is not type-checked against inputs.
  Mitigation: validate at startup that each grader's `matchOn`/`inputScope` resolves against the
  inputs it applies to, and fail fast with a clear message. This does not make the link
  type-safe; it converts silent misses into startup errors.
- **Grading concurrency.** `evaluate` uses `Promise.all` over inputs and `_run` uses it
  over samples. With large input sets this can issue many simultaneous LLM calls; the
  `WorkspaceManager`/`AgencyRunner` should cap concurrency. Cap policy is unspecified here.
- **Pool growth.** GEPA retains every admitted candidate's workspace on disk. Pruning dominated
  candidates is a possible later optimization; the first build keeps them.
- **Pairwise→pointwise migration risk.** Phase 2 changes greedy's acceptance semantics.
  Validate against the PR #283 fixtures and call out any acceptance differences in that PR.

## Testing

- **Author-interface unit tests:** a fake `WorkspaceManager` + deterministic LLM mocks (per the
  repo's `_internal` test-export and scoped-mock conventions) drive a full `greedy` and `gepa`
  iteration with no real LLM calls.
- **`BaseGrader` orchestration:** `samples`/`aggregate` (`any`/`all`/mean), gate short-circuit
  ordering, scalarization, and gate-aware `inputScores` (gate failure → 0).
- **`ParetoFrontier`:** frontier membership and weighted sampling over hand-constructed
  `inputScores` vectors (pure, no LLM).
- **EvalCache:** a single agent run is reused across multiple graders and across a parent
  re-grade on an overlapping minibatch.
- **Registry/CLI:** `--optimizer greedy|gepa` selects the strategy; unknown names error;
  default is `greedy`.
- **Human grader:** with a mock human-input provider it scores; with none bound (CI) it
  fails fast rather than blocking.
- **Regression:** Phase 1 leaves PR #283 fixtures green (no behavior change); Phase 2 documents
  any acceptance differences from the pairwise→pointwise switch.
