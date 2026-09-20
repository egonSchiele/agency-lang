// What `main` in evals/design-tool/agent.agency returns, and where the
// saved tool's code ends up.
import { type GraderContext } from "agency-lang/eval";

/** Mirrors `DesignInput` in agent.agency. */
export type DesignInput = {
  name: string;
  purpose: string;
  request: string;
  facts: Record<string, string>;
};

/** Mirrors `DesignLog` in agent.agency. */
export type DesignLog = {
  saved: boolean;
  error: string;
  questions: string[];
  lastDraft: string;
  rejected: string[];
};

/** The run's output, or null when the run ended before the node returned. */
export function readLog(ctx: GraderContext<DesignInput>): DesignLog | null {
  const output = ctx.output as Partial<DesignLog> | null;
  if (output === null || typeof output !== "object" || typeof output.saved !== "boolean") {
    return null;
  }
  return output as DesignLog;
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
  return saved === "" ? (readLog(ctx)?.lastDraft ?? "") : saved;
}
