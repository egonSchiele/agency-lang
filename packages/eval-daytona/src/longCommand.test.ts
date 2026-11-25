import { expect, it } from "vitest";

import { FakeSandbox, type FakeReply } from "./fakeSandbox.js";
import { CONSOLE_LOG, ENV_FILE, EXIT_FILE, PGID_FILE, runLongCommand } from "./longCommand.js";

/** A sandbox whose command "ends" on the given poll, printing `output` in
 *  pieces, one per poll. */
function sandboxEndingOnPoll(endsOn: number, exitText: string, pieces: string[] = []): FakeSandbox {
  let polls = 0;
  let tails = 0;
  return new FakeSandbox((command): FakeReply | undefined => {
    if (command.startsWith(`test -f ${EXIT_FILE}`)) {
      polls += 1;
      return { exitCode: polls >= endsOn ? 0 : 1 };
    }
    if (command.startsWith("tail -c")) {
      tails += 1;
      return { output: pieces[tails - 1] ?? "" };
    }
    if (command.startsWith(`cat ${EXIT_FILE}`)) {
      return { output: exitText };
    }
    return undefined;
  });
}

const fast = { pollSeconds: 1, sleep: async () => {} };
const base = { argv: ["agency", "eval", "run", "--test", "it's"], cwd: "/eval/project", env: {}, maxSeconds: 100 };

it("starts the command in its own process group, from cwd, with its exit code and group id written to files", async () => {
  const sandbox = sandboxEndingOnPoll(1, "0\n");
  await runLongCommand(sandbox, { ...base, ...fast });
  const line = sandbox.background[0];
  expect(line).toContain(`. ${ENV_FILE} && cd /eval/project && setsid --wait sh -c `);
  expect(line).toContain(`echo $$ > ${PGID_FILE}`);
  expect(line).toContain("exec timeout 100 ");
  expect(line).toContain(`> ${CONSOLE_LOG} 2>&1`);
  expect(line.endsWith(`; echo $? > ${EXIT_FILE}`)).toBe(true);
});

it("puts the environment in a root-only file, never on a command line", async () => {
  const sandbox = sandboxEndingOnPoll(1, "0\n");
  await runLongCommand(sandbox, { ...base, ...fast, env: { OPENROUTER_API_KEY: "sk-secret", ODD: "it's" } });
  expect(sandbox.files[ENV_FILE].toString()).toBe("export OPENROUTER_API_KEY=sk-secret\nexport ODD='it'\\''s'\n");
  expect(sandbox.commands.some((command) => command.includes(`chmod 600 ${ENV_FILE}`))).toBe(true);
  expect(sandbox.commands.join("\n")).not.toContain("sk-secret");
});

it("returns the exit code the command wrote", async () => {
  const result = await runLongCommand(sandboxEndingOnPoll(3, "2\n"), { ...base, ...fast });
  expect(result).toMatchObject({ exitCode: 2, timedOut: false, interrupted: false });
});

it("hands each poll's new output to onOutput, and asks for the log from where it left off", async () => {
  const sandbox = sandboxEndingOnPoll(3, "0\n", ["one\n", "", "two\n"]);
  const seen: string[] = [];
  await runLongCommand(sandbox, { ...base, ...fast, onOutput: (chunk) => seen.push(chunk) });
  expect(seen).toEqual(["one\n", "two\n"]);
  const tails = sandbox.commands.filter((command) => command.startsWith("tail -c"));
  expect(tails.slice(0, 3)).toEqual([
    `tail -c +1 ${CONSOLE_LOG} 2>/dev/null`,
    `tail -c +5 ${CONSOLE_LOG} 2>/dev/null`,
    `tail -c +5 ${CONSOLE_LOG} 2>/dev/null`,
  ]);
});

it("gives up with exit code 124 when the exit file never appears, five minutes past the limit", async () => {
  let clock = 0;
  const result = await runLongCommand(sandboxEndingOnPoll(Number.POSITIVE_INFINITY, ""), {
    ...base,
    pollSeconds: 30,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  expect(result).toMatchObject({ exitCode: 124, timedOut: true });
  expect(clock).toBeGreaterThan((100 + 300) * 1000);
  expect(clock).toBeLessThan((100 + 300 + 60) * 1000);
});

it("rethrows after five failed polls in a row, and not before", async () => {
  let failures = 0;
  const failing = (limit: number) =>
    new FakeSandbox((command) => {
      if (command.startsWith(`test -f ${EXIT_FILE}`)) {
        failures += 1;
        if (failures <= limit) {
          throw new Error("connection reset");
        }
        return { exitCode: 0 };
      }
      return command.startsWith(`cat ${EXIT_FILE}`) ? { output: "0" } : undefined;
    });
  expect((await runLongCommand(failing(4), { ...base, ...fast })).exitCode).toBe(0);
  failures = 0;
  await expect(runLongCommand(failing(5), { ...base, ...fast })).rejects.toThrow("connection reset");
});

it("on abort, interrupts the command's whole process group once and waits for it to end", async () => {
  const controller = new AbortController();
  let polls = 0;
  const sandbox = new FakeSandbox((command) => {
    if (command.startsWith(`test -f ${EXIT_FILE}`)) {
      polls += 1;
      if (polls === 2) {
        controller.abort();
      }
      return { exitCode: polls >= 5 ? 0 : 1 };
    }
    return command.startsWith(`cat ${EXIT_FILE}`) ? { output: "130" } : undefined;
  });
  const result = await runLongCommand(sandbox, { ...base, ...fast, signal: controller.signal });
  const kills = sandbox.commands.filter((command) => command.includes("kill -INT"));
  expect(kills).toEqual([`kill -INT -"$(cat ${PGID_FILE})"`]);
  expect(result).toMatchObject({ exitCode: 130, interrupted: true, timedOut: false });
});

it("after an abort, returns once the grace is over even if the command has not ended", async () => {
  const controller = new AbortController();
  controller.abort();
  let clock = 0;
  const result = await runLongCommand(sandboxEndingOnPoll(Number.POSITIVE_INFINITY, ""), {
    ...base,
    maxSeconds: 10_000,
    pollSeconds: 10,
    interruptGraceSeconds: 60,
    signal: controller.signal,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  expect(result).toMatchObject({ interrupted: true, exitCode: 124 });
  expect(clock).toBeLessThan(120_000);
});
