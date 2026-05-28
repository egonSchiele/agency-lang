import { agency, approve } from "agency-lang/runtime";

// Wraps `agency.interrupt(...)` in `agency.withHandler(approver)`.
// `approver` returns `approve("handled")`, so the interrupt is
// intercepted inside the handler chain and `agency.interrupt`
// resolves to that approve outcome — the run continues to
// completion in the same pass with no halt and no resume.
export async function run() {
  return agency.withHandler(
    async () => approve("handled"),
    async () => {
      const resp = await agency.interrupt({
        kind: "test",
        message: "needs approval",
        data: { foo: 1 },
      });
      return resp;
    },
  );
}
