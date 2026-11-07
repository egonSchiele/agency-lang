import { agency } from "agency-lang/runtime";

// True when a frame on the calling run's stack holds `command` in its
// `command` local. Each handler run in concurrent-handled-slow.agency keeps
// its own command there, so this tells whether that run's frame is still
// on the stack the runs share. It reads the run on its first line, before
// any await.
export function frameHoldsCommand(command) {
  const { stack } = agency.current();
  return stack.stack.some((frame) => frame.locals.command === command);
}
