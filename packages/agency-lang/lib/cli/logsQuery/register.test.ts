import * as fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Command } from "@/vendor/commander/index.js";

import { queryDeps, queryDir, writeLog } from "./queryFixture.js";
import { addLogsQueryCommands } from "./register.js";

describe("addLogsQueryCommands", () => {
  let dir: string;
  let printed: string[];
  let program: Command;
  beforeEach(() => {
    dir = queryDir();
    writeLog(dir, "log.jsonl", [
      { traceId: "old-run", minutesAgo: 30 },
      { traceId: "new-run", minutesAgo: 5 },
    ]);
    printed = [];
    program = new Command("agency").exitOverride();
    const logs = program.command("logs");
    addLogsQueryCommands(logs, () => ({
      ...queryDeps(dir),
      writeStdout: (text) => {
        printed.push(text);
      },
    }));
    process.exitCode = undefined;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const parse = (...args: string[]) =>
    program.parseAsync(["node", "agency", "logs", ...args, "--log", "log.jsonl"]);

  it("traces passes the selection and its own flags through", async () => {
    await parse("traces", "--last", "1", "--errors");
    expect(printed.join("")).toContain("0 with errors · showing 0");
    await parse("traces", "--trace", "old");
    expect(printed.at(-1)).toContain("old-run");
    expect(printed.at(-1)).not.toContain("new-run");
  });

  it("outline passes --approvals and --admin through", async () => {
    await parse("outline", "--approvals");
    expect(printed.at(-1)).toContain("std::read · approved");
    await parse("outline", "--admin", "--json");
    expect(
      JSON.parse(printed.at(-1)!).traces[0].rows.some(
        (row: { kind: string }) => row.kind === "machinery",
      ),
    ).toBe(true);
  });

  it("search passes every flag through", async () => {
    await parse(
      "search",
      "MODULE",
      "--all",
      "--kind",
      "user",
      "--limit",
      "1",
      "--context",
      "3",
      "--json",
    );
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({
      pattern: "MODULE",
      tracesSearched: 2,
      matched: 2,
      omitted: 1,
      hits: [{ address: "new-run/round:L:0:user", snippet: "…a module" }],
    });
    await parse("search", "MODULE", "--case-sensitive");
    expect(printed.at(-1)).toContain("no rows matched");
    await parse("search", "mod.le", "--regex");
    expect(printed.at(-1)).toContain("1 row matched");
  });

  it("a pattern after -- may start with a dash", async () => {
    await program.parseAsync([
      "node",
      "agency",
      "logs",
      "search",
      "--log",
      "log.jsonl",
      "--",
      "--force",
    ]);
    expect(printed.at(-1)).toContain("no rows matched");
    expect(process.exitCode).toBeUndefined();
  });

  it("a bad --last is refused with exit code 1", async () => {
    await parse("outline", "--last", "0");
    expect(printed.at(-1)).toContain("--last needs a positive whole number");
    expect(process.exitCode).toBe(1);
  });
});
