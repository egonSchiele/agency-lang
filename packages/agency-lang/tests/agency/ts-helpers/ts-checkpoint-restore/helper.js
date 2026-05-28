import { agency } from "agency-lang/runtime";

// Pins TS-side checkpoint + restore semantics inside withResumableScope:
//   1. setLocal("count", 1)
//   2. take checkpoint
//   3. mutate (setLocal("count", 999))
//   4. restore — throws RestoreSignal, runtime catches at node level,
//      restores state, restarts from the beginning of `node main()`.
//   5. On the re-execution, the scope's frame.locals are restored
//      from the checkpoint snapshot — `__userLocals.count` is 1 again.
//
// `restoreCalls` lives in JS module state (NOT in `__userLocals`, NOT
// in the frame). That's deliberate: module state is NOT serialized
// into checkpoints, so it survives the restore-and-restart cycle and
// breaks the would-be infinite-loop of "restore → re-enter → mutate
// → restore again". This pattern mirrors `interrupt-resume-idempotency`'s
// `handlerCalls` counter from PR #213.
let restoreCalls = 0;

export async function run() {
  return agency.withResumableScope({ name: "cp-restore" }, async (s) => {
    s.setLocal("count", 1);
    const cpId = await agency.checkpoint();
    if (restoreCalls === 0) {
      s.setLocal("count", 999);
      restoreCalls = 1;
      // Throws RestoreSignal — propagates out of withResumableScope's
      // body, out of the surrounding runner.step, and is caught by
      // runNode's RestoreSignal catch block.
      agency.restore(cpId);
    }
    // Post-restore execution path. count is 1 (the pre-mutation
    // value snapshotted in the checkpoint).
    return s.getLocal("count");
  });
}
