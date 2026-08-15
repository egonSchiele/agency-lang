import { describe, expect, it } from "vitest";

import { substituteTask, tokenizeCommand } from "./commandLine.js";

describe("tokenizeCommand", () => {
  it("splits on whitespace and honors single and double quotes", () => {
    expect(tokenizeCommand(`agency agent --policy approve-all -p -- {task}`)).toEqual([
      "agency",
      "agent",
      "--policy",
      "approve-all",
      "-p",
      "--",
      "{task}",
    ]);
    expect(tokenizeCommand(`run "a b" 'c d' e`)).toEqual(["run", "a b", "c d", "e"]);
  });

  it("joins adjacent chunks and keeps empty quoted args", () => {
    expect(tokenizeCommand(`--flag="a b"`)).toEqual([`--flag=a b`]);
    expect(tokenizeCommand(`run ""`)).toEqual(["run", ""]);
    expect(tokenizeCommand(`  padded   spaces  `)).toEqual(["padded", "spaces"]);
  });

  it("does nothing shell-like: no expansion, no operators", () => {
    // $HOME, ;, && are ordinary bytes — there is no shell to interpret them
    expect(tokenizeCommand(`echo $HOME; rm -rf /`)).toEqual(["echo", "$HOME;", "rm", "-rf", "/"]);
  });

  it("throws on an unbalanced quote, naming the command", () => {
    expect(() => tokenizeCommand(`run "unclosed`)).toThrow(/unbalanced quote/);
    expect(() => tokenizeCommand(`run 'unclosed`)).toThrow(/unbalanced quote/);
  });
});

describe("substituteTask", () => {
  it("replaces every occurrence, inside tokens too", () => {
    expect(substituteTask(["-p", "{task}", "--again={task}"], "do it")).toEqual([
      "-p",
      "do it",
      "--again=do it",
    ]);
  });

  it("serializes an object task as JSON", () => {
    expect(substituteTask(["-p", "{task}"], { rows: [1] })).toEqual(["-p", `{"rows":[1]}`]);
  });

  it("throws when no token carries the placeholder — the task must reach the agent", () => {
    expect(() => substituteTask(["agency", "agent"], "t")).toThrow(/\{task\}/);
  });
});
