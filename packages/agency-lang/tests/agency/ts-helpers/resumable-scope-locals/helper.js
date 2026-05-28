import { agency } from "agency-lang/runtime";

// Pins that `s.setLocal` / `s.getLocal` participate correctly in the
// real resume cycle. The scope writes "pre" before the interrupt and
// "post" after — on resume, the in-flight step body short-circuits
// via the persisted interrupt id, then the `setLocal("phase", "post")`
// line executes for the first time, and `getLocal("phase")` reads
// "post" through the `__userLocals` frame slot.
//
// If user locals were not serialized into the frame, the scope
// frame's locals on resume would have no `__userLocals` entry and
// the helper would return `undefined` instead of "post".
export async function run() {
  return agency.withResumableScope({ name: "locals" }, async (s) => {
    s.setLocal("phase", "pre");
    await s.step(async () => {
      await agency.interrupt({
        kind: "x",
        message: "wait",
        data: null,
      });
    });
    s.setLocal("phase", "post");
    return s.getLocal("phase");
  });
}
