import { agency } from "agency-lang/runtime";

// Raises an interrupt from TypeScript through the run's handle, the same
// way an interop helper asks for permission. It takes the run on its
// first line and waits `waitMs` before raising, so a fixture can order
// the raises of two fork arms.
export async function raiseFromTs(tag, waitMs) {
  const run = agency.current();
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const response = await run.interrupt({
    effect: "test::fromTs",
    message: `ts raise in arm ${tag}`,
    data: { tag },
  });
  return response;
}
