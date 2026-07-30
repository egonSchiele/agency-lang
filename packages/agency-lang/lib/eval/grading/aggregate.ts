import type { Grade } from "./types.js";

/**
 * Combine the k single-shot trials of one grader into a single Grade.
 * Scalar scores are averaged; binary scores use `any`/`all`; feedback is the
 * newline-joined non-empty feedback across trials (undefined if none).
 *
 * Throws on an empty trials array: an empty `every`/`some` would silently
 * report a passing binary grade. Callers guarantee at least one trial.
 */
export function aggregateGrades(trials: Grade[], mode: "any" | "all"): Grade {
  if (trials.length === 0) {
    throw new Error("aggregateGrades requires at least one trial");
  }

  const feedbacks = trials.map((t) => t.feedback).filter((f): f is string => Boolean(f));
  const feedback = feedbacks.length > 0 ? feedbacks.join("\n") : undefined;

  const scalars = trials.flatMap((t) => (t.score.kind === "scalar" ? [t.score.value] : []));
  if (scalars.length > 0) {
    const value = scalars.reduce((sum, v) => sum + v, 0) / scalars.length;
    return { score: { kind: "scalar", value }, ...(feedback ? { feedback } : {}) };
  }

  const passes = trials.map((t) => t.score.kind === "binary" && t.score.pass);
  const pass = mode === "any" ? passes.some(Boolean) : passes.every(Boolean);
  return { score: { kind: "binary", pass }, ...(feedback ? { feedback } : {}) };
}
