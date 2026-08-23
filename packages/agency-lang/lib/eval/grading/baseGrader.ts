import { aggregateGrades } from "./aggregate.js";
import type { Grade, GraderInput, GraderOptions, Test } from "./types.js";

/**
 * Base class for graders. Authors implement the single-shot `_run`; the base
 * handles k-sample repetition + aggregation, gating policy, and input scoping.
 */
export abstract class BaseGrader {
  constructor(protected readonly options: GraderOptions = {}) {}

  /** Who this grader is, by revision, for the score rows it writes: a module
   *  grader is `<path>@<sha256 of the file>` (set by loadGradingModule), so
   *  editing the module in place is a new annotator; the bundled goal judge is
   *  `goal-judge@<version>` (a test pins the version to the prompt's hash);
   *  a custom judge file is `<path>@<sha256 of the file>`; anything else constructed in
   *  process is `inline:<name>`. */
  annotator(): { kind: "grader" | "judge"; id: string } {
    if (this.revision !== undefined) return { kind: "grader", id: this.revision };
    return { kind: "grader", id: `inline:${this.name()}` };
  }

  /** @internal Set by loadGradingModule on every grader a module exports. */
  revision?: string;

  /** Files this grader reads from disk at grade time, as the paths were
   *  declared (relative ones are cwd-relative). A run directory snapshots
   *  them next to the grading bundle so a copied run still grades;
   *  `rebindExternalFile` is called with the declared path and the copy's
   *  absolute path. Default: none. */
  externalFiles(): string[] {
    return [];
  }
  rebindExternalFile(_from: string, _to: string): void {}

  /** Subclasses set a default; `options.name` overrides it. */
  protected abstract readonly defaultName: string;
  name(): string {
    return this.options.name ?? this.defaultName;
  }

  /** One-line human description for the startup echo. Default: the grader name. */
  describe(): string {
    return this.name();
  }

  /** Pre-flight check against an input before the run. Default: nothing to check.
   *  Match-based graders override this to fail fast on an unresolved matchOn. */
  validateInput(_input: Test): void {
    /* no-op */
  }

  /** Single-shot grade. Declarative: no sampling, no aggregation. */
  protected abstract _run(input: GraderInput): Promise<Grade>;

  mustPass(): boolean {
    return this.options.mustPass ?? false;
  }

  weight(): number {
    return this.options.weight ?? 1;
  }

  /** Orchestration: run `_run` k times, aggregate by score kind. */
  async run(input: GraderInput): Promise<Grade> {
    const samples = this.options.samples ?? 1;
    if (!Number.isInteger(samples) || samples < 1) {
      throw new Error(`${this.name()}: samples must be a positive integer, got ${samples}`);
    }
    const trials = await Promise.all(Array.from({ length: samples }, () => this._run(input)));
    return aggregateGrades(trials, this.options.aggregate ?? "all");
  }

  passes(grade: Grade): boolean {
    if (grade.score.kind === "binary") return grade.score.pass;
    return grade.score.value >= (this.options.threshold ?? 0);
  }
}
