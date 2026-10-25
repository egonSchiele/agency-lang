import { agency } from "agency-lang/runtime";

export async function fakeRepl(onSubmit) {
  const run = agency.current();
  for (const line of process.env.LINES.split(",")) {
    await run.call(onSubmit, line);
  }
}
