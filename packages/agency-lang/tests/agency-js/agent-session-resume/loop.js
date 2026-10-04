import { agency } from "agency-lang/runtime";

// The REPL shape: a TypeScript loop that calls an Agency callback per line.
// The lines come from the environment, read here rather than passed in from
// Agency, so the resumed process can feed different ones.
export async function fakeRepl(onSubmit) {
  // Take the run on the first line, before the first await.
  const run = agency.current();
  for (const line of process.env.LINES.split(",")) {
    await run.call(onSubmit, line);
  }
}
