import { agency } from "agency-lang/runtime";

// The REPL shape: a TypeScript loop that calls an Agency callback per line.
// A reply that is a list of interrupts is kept as their effects.
export async function fakeRepl(onSubmit) {
  const run = agency.current();
  const replies = [];
  for (const line of ["hello", "stop", "world"]) {
    const reply = await run.call(onSubmit, line);
    replies.push(Array.isArray(reply) ? reply.map((intr) => intr.effect) : reply);
  }
  return replies;
}
