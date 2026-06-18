import { aggregateGrades } from "./aggregate.js";
import type { Grade, GraderInput, GraderOptions, Input } from "./types.js";

/**
 * Base class for graders. Authors implement the single-shot `_run`; the base
 * handles k-sample repetition + aggregation, gating policy, and input scoping.
 */
export abstract class BaseGrader {
  constructor(protected readonly options: GraderOptions = {}) {}

  /** Subclasses set a default; `options.name` overrides it. A getter avoids field init-order issues. */
  protected abstract readonly defaultName: string;
  get name(): string {
    return this.options.name ?? this.defaultName;
  }

  /** Single-shot grade. Declarative: no sampling, no aggregation. */
  protected abstract _run(input: GraderInput): Promise<Grade>;

  get isGate(): boolean {
    return this.options.mustPass ?? false;
  }

  get weight(): number {
    return this.options.weight ?? 1;
  }

  /** Whether this grader runs on `input`. Default (no inputScope) → every input. */
  gradesInput(input: Input): boolean {
    const scope = this.options.inputScope;
    if (!scope) return true;
    if ("tag" in scope) {
      const tags = input.metadata?.tags;
      return Array.isArray(tags) && tags.includes(scope.tag);
    }
    return input.id !== undefined && scope.ids.includes(input.id);
  }

  /** Orchestration: run `_run` k times, aggregate by score kind. */
  async run(input: GraderInput): Promise<Grade> {
    const samples = this.options.samples ?? 1;
    const trials = await Promise.all(Array.from({ length: samples }, () => this._run(input)));
    return aggregateGrades(trials, this.options.aggregate ?? "all");
  }

  passes(grade: Grade): boolean {
    if (grade.score.kind === "binary") return grade.score.pass;
    return grade.score.value >= (this.options.threshold ?? 0);
  }
}
