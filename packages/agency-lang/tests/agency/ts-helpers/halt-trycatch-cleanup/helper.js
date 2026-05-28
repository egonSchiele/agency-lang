import { agency } from "agency-lang/runtime";

// Module-scoped because the agency entry reads it after the scope
// returns; the scope's internal `try/finally` mutates it. Surviving
// a `s.halt(...)` call is the load-bearing claim.
let cleanupCalls = [];

export function getCleanup() {
  return cleanupCalls;
}

export async function run() {
  cleanupCalls = [];
  const result = await agency.withResumableScope({ name: "halt" }, async (s) => {
    try {
      await s.step(() => "a");
      s.halt("halted");
      // s.step short-circuits via shouldSkip after halt, but the
      // surrounding try/finally MUST still run — that's what we pin.
      await s.step(() => "b");
    } finally {
      cleanupCalls.push("ran");
    }
  });
  return result;
}
