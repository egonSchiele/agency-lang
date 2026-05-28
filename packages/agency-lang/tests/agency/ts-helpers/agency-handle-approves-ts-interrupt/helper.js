import { agency } from "agency-lang/runtime";

// Raises `agency.interrupt(...)` from JS. The agency `handle ... with`
// block in agent.agency intercepts it via the SAME `ctx.handlers`
// stack the codegen interrupts use. This pins the contract called
// out in agencyInterrupt.ts's header comment:
//   "a TS function called from Agency code can have its
//    agency.interrupt(...) caught by a handle block defined in the
//    calling Agency code"
export async function raise() {
  const resp = await agency.interrupt({
    kind: "test::ask",
    message: "needs approval",
    data: { foo: 1 },
  });
  return resp;
}
