import { agency, reject } from "agency-lang/runtime";

// Mirror of `interrupt-handler-approve` for the reject path. The
// handler returns `reject("nope")`, so `agency.interrupt` resolves
// to that reject outcome and the run continues to completion in
// the same pass.
export async function run() {
  return agency.withHandler(
    async () => reject("nope"),
    async () => {
      const resp = await agency.interrupt({
        kind: "test",
        message: "needs approval",
        data: {},
      });
      return resp;
    },
  );
}
