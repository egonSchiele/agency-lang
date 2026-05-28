import { agency } from "agency-lang/runtime";

// Pins that a TS-side `agency.checkpoint()` issued inside an
// `agency.withCallsite(loc, ...)` block attributes the new checkpoint
// to the override location (`loc.moduleId`/`scopeName`/`stepPath`),
// not the surrounding agency step's auto-seeded callsite.
//
// This is the contract documented on `agency.withCallsite`: "TS
// helpers that subdivide their own work into substeps can use this
// to give each substep a distinct location in debugger UIs / trace
// files."
export async function run() {
  return await agency.withCallsite(
    { moduleId: "my.helper", scopeName: "phase-a", stepPath: "9.9" },
    async () => {
      const cpId = await agency.checkpoint();
      const cp = agency.getCheckpoint(cpId);
      return {
        moduleId: cp.moduleId,
        scopeName: cp.scopeName,
        stepPath: cp.stepPath,
      };
    },
  );
}
