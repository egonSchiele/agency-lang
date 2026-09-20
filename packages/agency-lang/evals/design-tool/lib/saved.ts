// Every test carries this grader: a run that saves nothing has failed,
// whatever its drafts looked like.
import { binary, grader, type Grader } from "agency-lang/eval";
import { readLog, savedSource, type DesignInput } from "./designLog.js";

export function saved(): Grader<DesignInput> {
  return grader<DesignInput>(
    (ctx) => {
      const log = readLog(ctx);
      if (log === null) {
        return binary(false, "the run has no output, so it ended before designTool returned");
      }
      if (!log.saved) {
        return binary(false, `not saved: ${log.error}`);
      }
      if (savedSource(ctx) === "") {
        return binary(false, "designTool reported success but the toolbox holds no impl.agency");
      }
      return binary(true, "the tool was saved");
    },
    { name: "saved" },
  );
}
