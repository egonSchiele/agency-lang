// End to end: `agency run --detach <output-file>`, which starts a program
// in the background and returns at once, and `--messages`, which seeds the
// program's first thread. Each test waits on a file the program writes.
// No test signals the pid it reads from the command's output: the programs
// end by themselves, and each has a deadline of its own.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";

import { EXIT_CODE_USAGE_ERROR } from "@/constants.js";
import {
  CLI,
  SEED,
  WRITES_THREAD,
  fixtureFolder,
  startCli,
  throwawayHome,
  waitFor,
  waitForFile,
  type StartedCli,
  type Throwaway,
} from "./spawnTestHelpers.js";

const START_MS = 60_000;
const TEST_MS = 120_000;

// Prints, writes a marker, and waits for `go.txt`. It gives up by itself
// after about thirty seconds, so it cannot outlive a failed test for long.
const WAITS = `import { exists } from "std::shell"

node main() {
  print("the program is running")
  write(filename: "marker.txt", content: "1", dir: ".") with approve
  let checks = 0
  while (checks < 600) {
    const go = exists("go.txt") with approve
    if (go) {
      print("the program was told to go")
      return "done"
    }
    sleep(50)
    checks = checks + 1
  }
  print("the program gave up")
}
`;

describe.skipIf(!existsSync(CLI))("agency run --detach (end-to-end)", () => {
  let home: Throwaway;
  let fixture: Throwaway;
  let started: StartedCli[] = [];

  function setUp(files: Record<string, string>): void {
    home = throwawayHome();
    fixture = fixtureFolder(".agency-detach-spawn-", files);
  }
  function run(args: string[]): StartedCli {
    const cli = startCli(fixture.dir, args, { AGENCY_HOME: home.dir });
    started.push(cli);
    onTestFailed(() => console.log(`agency ${args.join(" ")} wrote:\n${cli.output()}`));
    return cli;
  }
  const file = (name: string): string => path.join(fixture.dir, name);
  /** The report a detached start prints as its last line. */
  const report = (cli: StartedCli): { pid: number; outputFile: string } =>
    JSON.parse(cli.output().trim().split("\n").at(-1)!);

  afterEach(async () => {
    for (const cli of started) cli.stop();
    await Promise.all(started.map((cli) => cli.exited));
    started = [];
    fixture.remove();
    home.remove();
  });

  it(
    "returns at once with the program's pid, and the program runs on under its title",
    async () => {
      setUp({ "prog.agency": WAITS });
      const cli = run(["run", "--detach", "out.log", "prog.agency"]);
      expect(await cli.exited).toBe(0);
      const { pid, outputFile } = report(cli);
      expect(pid).toBeGreaterThan(0);
      expect(outputFile).toBe(file("out.log"));

      // The command has exited, and the program is still at work.
      await waitForFile(file("marker.txt"), START_MS);
      const shown = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      expect(shown.trim().startsWith("agency run prog.agency")).toBe(true);

      writeFileSync(file("go.txt"), "1");
      await waitFor(
        () => readFileSync(file("out.log"), "utf8").includes("the program was told to go"),
        START_MS,
        "the program's last line in its output file",
      );
      expect(readFileSync(file("out.log"), "utf8")).toContain("the program is running");
    },
    TEST_MS,
  );

  it(
    "refuses --detach together with -i, naming both",
    async () => {
      setUp({ "prog.agency": WAITS });
      const cli = run(["run", "-i", "--detach", "out.log", "prog.agency"]);
      expect(await cli.exited).not.toBe(0);
      expect(cli.output()).toContain("--detach");
      expect(cli.output()).toContain("--interactive");
      expect(existsSync(file("marker.txt"))).toBe(false);
    },
    TEST_MS,
  );

  it(
    "refuses an output file that is a symbolic link, and starts nothing",
    async () => {
      setUp({ "prog.agency": WAITS, "real.log": "" });
      symlinkSync(file("real.log"), file("link.log"));
      const cli = run(["run", "--detach", "link.log", "prog.agency"]);
      expect(await cli.exited).toBe(EXIT_CODE_USAGE_ERROR);
      expect(cli.output()).toContain("symbolic link");
      expect(readFileSync(file("real.log"), "utf8")).toBe("");
      expect(existsSync(file("marker.txt"))).toBe(false);
    },
    TEST_MS,
  );

  it(
    "seeds the first thread from standard input",
    async () => {
      setUp({ "prog.agency": WRITES_THREAD });
      // `startCli` gives the command no standard input, so this one is
      // started here, with the seed on a pipe.
      const child = spawn(
        process.execPath,
        [CLI, "run", "--detach", "out.log", "--messages", "-", "prog.agency"],
        { cwd: fixture.dir, env: { ...process.env, AGENCY_HOME: home.dir } },
      );
      child.stdin.end(JSON.stringify(SEED));
      const code = await new Promise((resolve) => child.on("exit", resolve));
      expect(code).toBe(0);
      await waitForFile(file("thread.json"), START_MS);
      const thread = readFileSync(file("thread.json"), "utf8");
      expect(thread).toContain("the seed question");
      expect(thread).toContain("the seed answer");
    },
    TEST_MS,
  );

  it(
    "seeds the first thread from a file, and leaves the file where it is",
    async () => {
      setUp({ "prog.agency": WRITES_THREAD, "seed.json": JSON.stringify(SEED) });
      const cli = run(["run", "--messages", "seed.json", "prog.agency"]);
      expect(await cli.exited).toBe(0);
      expect(readFileSync(file("thread.json"), "utf8")).toContain("the seed question");
      expect(existsSync(file("seed.json"))).toBe(true);
    },
    TEST_MS,
  );

  it(
    "refuses --messages - without --detach",
    async () => {
      setUp({ "prog.agency": WRITES_THREAD });
      const cli = run(["run", "--messages", "-", "prog.agency"]);
      expect(await cli.exited).toBe(EXIT_CODE_USAGE_ERROR);
      expect(cli.output()).toContain("needs --detach");
      expect(existsSync(file("thread.json"))).toBe(false);
    },
    TEST_MS,
  );
});
