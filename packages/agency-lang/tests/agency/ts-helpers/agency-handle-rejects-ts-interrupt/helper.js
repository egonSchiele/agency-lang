import { agency } from "agency-lang/runtime";

// Mirror of agency-handle-approves-ts-interrupt: JS raises an
// interrupt with `agency.interrupt(...)`, and the agency `handle`
// block in agent.agency intercepts it via `reject(...)`. Pins the
// reject-from-agency-handle path of the cross-surface handler
// stack documented in agencyInterrupt.ts.
export async function raise() {
  const resp = await agency.interrupt({
    kind: "test::ask",
    message: "needs approval",
    data: { foo: 1 },
  });
  return resp;
}
