import { flawedPlanGraders } from "../lib/reviewGraders.js";

export default flawedPlanGraders({
  reason:
    "The spec builds a new, one-off way to stop a running turn: a mark on the conversation thread meaning " +
    "'the user wants to steer' and a new gate in the tool loop that checks it. Agency already has several " +
    "ways to pause a run and change it before it continues: pauseSignal (docs/dev/runtime/pause.md), the " +
    "debugger's attach and pause, which can stop inside a subagent's loop (docs/dev/cli/debugger.md, " +
    "docs/dev/cli/debugger-attach.md), and checkpoint patches, which include an appendMessage edit on the " +
    "active thread (docs/dev/runtime/checkpoint-patch.md). Steering should be built on one of these.",
});
