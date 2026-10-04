import { __call } from "agency-lang/runtime";

// The REPL shape: a TypeScript loop that calls an Agency callback per line.
// The lines come from the environment, read here rather than passed in from
// Agency, so the resumed process can feed different ones.
//
// The loop chains the calls with `.then` and has no `await`. A hand-written
// .js helper is loaded as written, and after a real `await` it has no run
// context, so a callback it called then would fail. `.then` keeps the context.
// See docs/dev/runtime/running-without-node.md.
export function fakeRepl(onSubmit) {
  const lines = process.env.LINES.split(",");
  return lines.reduce(
    (previous, line) =>
      previous.then(() => __call(onSubmit, { type: "positional", args: [line] })),
    Promise.resolve(),
  );
}
