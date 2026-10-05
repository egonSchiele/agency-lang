import { agency } from "agency-lang/runtime";

// Calls two Agency functions at the same time through one handle, after a
// wait. Both calls are in flight together, so neither may be counted as
// "the run is busy" against the other.
export async function callBoth(first, second) {
  const run = agency.current();
  await new Promise((resolve) => setTimeout(resolve, 5));
  return Promise.all([run.call(first, "a"), run.call(second, "b")]);
}
