// What `evalMain` in stdlib/toolbox.agency saves for the graders, and where
// the saved tool's code ends up.
import { type GraderContext } from "agency-lang/eval";

/** Mirrors `DesignToolEvalInput` in stdlib/toolbox.agency. */
export type DesignInput = {
  name: string;
  purpose: string;
  request: string;
  facts: Record<string, string>;
};

/** Mirrors `DesignToolEvalLog` in stdlib/toolbox.agency. */
export type DesignLog = {
  saved: boolean;
  error: string;
  questions: string[];
  reviews: {
    notes: string[];
    blocking: string[];
    unresolved: { point: string; reason: string }[];
  }[];
  rejected: string[];
};

export function readLog(ctx: GraderContext<DesignInput>): DesignLog | null {
  const text = ctx.workdirFile("design-log.json");
  if (text === "") {
    return null;
  }
  return JSON.parse(text) as DesignLog;
}

/** The saved tool's code, or "" when nothing was saved. */
export function savedSource(ctx: GraderContext<DesignInput>): string {
  const name = ctx.test.input?.name ?? "";
  return ctx.workdirFile(`toolbox/${name}/impl.agency`);
}

/** The saved code, or the last draft the user saw when nothing was saved,
 *  so a judge can still say what was wrong with it. */
export function bestSource(ctx: GraderContext<DesignInput>): string {
  const saved = savedSource(ctx);
  return saved === "" ? ctx.workdirFile("last-draft.agency") : saved;
}
