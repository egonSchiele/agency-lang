import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";

// Build the diagnosis prompt the doctor seeds the agent with. Kept pure
// and exported so it can be unit-tested without launching the agent.
export function buildDoctorPrompt(file: string, symptom?: string): string {
  const symptomLine =
    symptom && symptom.trim() !== ""
      ? `They described the problem as: "${symptom}".`
      : "They did not describe the specific problem.";
  return [
    `The user is having trouble with the Agency file \`${file}\` and wants you to investigate.`,
    symptomLine,
    "",
    "Investigate the file and figure out what is wrong. Read the file first, " +
      "then use your diagnostic tools — `typecheck`, `parseAST`, and " +
      '`agencyCli(["ast", ...])` / `agencyCli(["typecheck", ...])` — to ' +
      "surface parse, syntax, and type errors.",
    "",
    "Agency has a number of parser and language gotchas that new users " +
      "frequently hit (for example, comments are not allowed inside object " +
      "literals). Before you conclude, read the bundled Troubleshooting " +
      'guide\'s "Syntax gotchas" section (via `docSkill`) and check the file ' +
      "against those known gotchas.",
    "",
    "Report what you found and, if you can, how to fix it.",
  ].join("\n");
}

// `agency doctor <file> [--symptom <text>]` — launch the agency agent in
// interactive mode, seeded with a diagnosis prompt routed to the code
// subagent. A thin wrapper over the generic --interactive/--agent flags.
export function doctor(
  config: AgencyConfig,
  file: string,
  opts: { symptom?: string } = {},
): void {
  const prompt = buildDoctorPrompt(file, opts.symptom);
  // `--` ends flag parsing so the prompt (which may start with `-`) is
  // treated as a positional by the agent's std::args parser.
  runBundledAgent(config, "agency-agent", [
    "--interactive",
    "--agent",
    "code",
    "--",
    prompt,
  ]);
}
