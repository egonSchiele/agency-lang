import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { createProgram } from "../../../scripts/agency.js";
import type { Command } from "@/vendor/commander/index.js";

// The weekly workflow calls the CLI by hand-written flags. A renamed flag
// would otherwise surface as a failed Sunday run nobody watches; this checks
// every flag in the workflow against the command's registered options.

const WORKFLOW = path.resolve(__dirname, "../../../../../.github/workflows/agent-evals.yml");

/** Every `agency <sub> <command> …` invocation in the workflow, unwrapped
 *  across backslash continuations, as the words after `agency.js`. */
function invocations(): string[][] {
  const text = fs.readFileSync(WORKFLOW, "utf8").replace(/\\\n\s*/g, " ");
  return [...text.matchAll(/agency\.js ([^\n]+)/g)].map((match) => match[1].trim().split(/\s+/));
}

function subcommand(program: Command, names: string[]): Command {
  return names.reduce((command, name) => {
    const found = command.commands.find((child) => child.name() === name);
    if (found === undefined) throw new Error(`no command ${names.join(" ")}`);
    return found;
  }, program);
}

/** The `--flag`s of an invocation. Quoted values (the agent command) are
 *  skipped: their own `--policy`/`-p` belong to `agency agent`. */
function flagsOf(words: string[]): string[] {
  const flags: string[] = [];
  let inQuote = false;
  for (const word of words) {
    const quotes = (word.match(/"/g) ?? []).length;
    if (!inQuote && /^--?[a-z]/.test(word)) flags.push(word);
    if (quotes % 2 === 1) inQuote = !inQuote;
  }
  return flags;
}

describe("agent-evals.yml", () => {
  const program = createProgram();
  const found = invocations();

  it("invokes eval run, eval grade, eval upload, and remote link", () => {
    const heads = found.map((words) => words.slice(0, 2).join(" "));
    expect(heads).toEqual(
      expect.arrayContaining(["remote link", "eval run", "eval grade", "eval upload"]),
    );
  });

  it("uses only flags the commands register", () => {
    for (const words of found) {
      const command = subcommand(program, words.slice(0, 2));
      const known = command.options.flatMap((option) => [option.long, option.short]);
      for (const flag of flagsOf(words.slice(2))) {
        expect(known, `${words.slice(0, 2).join(" ")} ${flag}`).toContain(flag);
      }
    }
  });
});
