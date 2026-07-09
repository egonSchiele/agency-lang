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
    "Report what you found. If you found a problem, explain the fix and " +
      "offer to apply it. If the user agrees, make the change yourself with " +
      "your edit tools (the user is asked to approve each edit), then " +
      "re-run `typecheck` to confirm the file is clean.",
  ].join("\n");
}

// Build the argv forwarded to the bundled agent. Kept pure and exported so
// the flag assembly can be unit-tested without launching the agent. Debug
// flags go BEFORE the `--` terminator (tokens after `--` are positionals to
// the agent's std::args parser); the prompt is the sole positional after it.
export function buildDoctorArgs(opts: {
  file: string;
  symptom?: string;
  trace?: string | true;
  logFile?: string;
}): string[] {
  const prompt = buildDoctorPrompt(opts.file, opts.symptom);
  const debug: string[] = [];
  if (opts.trace !== undefined) {
    debug.push("--trace");
    if (typeof opts.trace === "string") debug.push(opts.trace);
  }
  if (opts.logFile) debug.push("--log-file", opts.logFile);
  return ["--interactive", "--agent", "code", ...debug, "--", prompt];
}

// `agency doctor <file> [--symptom <text>] [--trace [file]] [--log-file <path>]`
// — launch the agency agent in interactive mode, seeded with a diagnosis prompt
// routed to the code subagent. A thin wrapper over the generic
// --interactive/--agent flags.
export function doctor(
  config: AgencyConfig,
  file: string,
  opts: { symptom?: string; trace?: string | true; logFile?: string } = {},
): void {
  runBundledAgent(config, "agency-agent", buildDoctorArgs({ file, ...opts }));
}
