import { grader } from "agency-lang/eval";

// Scores 1 only when the output is the bare city name: no sentence around it,
// no trailing chatter. A score, not a must-pass gate: the optimizer refuses a
// program whose baseline fails a gate, and this suite exists to be optimized
// from a failing baseline. Shared by both tests in the suite.
export function bareCityGrader(city: string) {
  return grader(
    ({ output }) => {
      const text = String(output).trim();
      if (new RegExp(`^${city}[.!]?$`, "i").test(text)) return 1;
      return {
        score: { kind: "scalar" as const, value: 0 },
        feedback: `expected exactly ${JSON.stringify(city)}, got ${JSON.stringify(text)}`,
      };
    },
    { name: `bare-${city.toLowerCase()}` },
  );
}
