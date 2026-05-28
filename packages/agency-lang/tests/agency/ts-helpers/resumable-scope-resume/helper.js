import { agency } from "agency-lang/runtime";

// Per-step execution counters. Initialized ONCE at module load —
// not reset inside `runScope` because resume re-enters runScope from
// the top, and a per-call reset would clobber the first pass's
// counts. The load-bearing claim:
//   - s1 ran once (cached on resume)
//   - s2 ran twice (in-flight when interrupt fired; replayed on
//     resume, this time finding the persisted response)
//   - s3 ran once (only after resume completes the in-flight step)
const calls = { s1: 0, s2: 0, s3: 0 };

export function getCalls() {
  return calls;
}

export async function runScope() {
  return agency.withResumableScope({ name: "test" }, async (s) => {
    const v1 = await s.step(() => {
      calls.s1 += 1;
      return "first";
    });
    const v2 = await s.step(async () => {
      calls.s2 += 1;
      const resp = await agency.interrupt({
        kind: "pause",
        message: "wait",
        data: v1,
      });
      return resp.value;
    });
    const v3 = await s.step(() => {
      calls.s3 += 1;
      return "third";
    });
    return { v1: v1, v2: v2, v3: v3 };
  });
}
