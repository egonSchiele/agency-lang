import { __call } from "agency-lang/runtime";

// The REPL shape: a TypeScript loop that calls an Agency callback per line.
// The lines come from the environment, read here rather than passed in from
// Agency, so the resumed process can feed different ones.
export async function fakeRepl(onSubmit) {
  for (const line of process.env.LINES.split(",")) {
    await __call(onSubmit, { type: "positional", args: [line] });
  }
}
