import { agency } from "agency-lang/runtime";

// Module-level counter so the agency entry can read it after the
// resume cycle completes. The load-bearing claim:
//   - First pass: body calls agency.interrupt, no persisted id,
//     handler fires (counter = 1), returns undefined to propagate,
//     interrupt halts.
//   - Resume: body re-runs, agency.interrupt sees the persisted id
//     in frame.locals and returns the user's response immediately
//     WITHOUT consulting the handler chain. Counter must stay at 1.
let handlerCalls = 0;

export function getHandlerCalls() {
  return handlerCalls;
}

export async function run() {
  // NOTE: do NOT reset `handlerCalls` here — resume re-enters `run()`
  // from the top, and a reset would clobber the first pass's count.
  return agency.withHandler(
    async () => {
      handlerCalls += 1;
      // Return undefined => no decision; propagate to user.
      return undefined;
    },
    async () => {
      const resp = await agency.interrupt({
        kind: "ask",
        message: "?",
        data: null,
      });
      return resp.value;
    },
  );
}
