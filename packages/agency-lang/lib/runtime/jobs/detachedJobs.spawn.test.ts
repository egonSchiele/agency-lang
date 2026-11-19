// End to end: a real runner process, started detached, running a real
// command. Needs `make` (or `pnpm run build`) first, because the runner is
// `dist/lib/runtime/jobs/runnerMain.js`. Every test stops what it started.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { nodeHost } from "../../host/node/nodeHost.js";
import { throwawayHome, type Throwaway } from "../../cli/spawnTestHelpers.js";
import {
  RUNNER_DIED_STOPPED,
  jobOutputSince,
  jobStatus,
  launchJob,
  requestStop,
} from "./detachedJobs.js";

const WAIT_MS = 10_000;
const POLL_MS = 100;
const TEST_MS = 60_000;

let home: Throwaway;
const savedHome = process.env.AGENCY_HOME;
const leftRunning: number[] = [];

beforeAll(() => {
  home = throwawayHome();
  process.env.AGENCY_HOME = home.dir;
});

afterEach(async () => {
  const host = nodeHost();
  for (const pid of leftRunning.splice(0)) {
    if (host.subprocess.processState(pid) === "alive") {
      await host.subprocess.stopGroup(pid);
    }
  }
});

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.AGENCY_HOME;
  } else {
    process.env.AGENCY_HOME = savedHome;
  }
  home.remove();
});

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    value = await read();
  }
  return value;
}

describe("a detached job", () => {
  it(
    "runs, prints, and stops",
    async () => {
      const host = nodeHost();
      const launched = await launchJob(host, {
        command: "echo one; sleep 30",
        label: "echo",
        cwd: host.system.cwd(),
        maxMs: 60_000,
      });
      leftRunning.push(launched.runnerPid!);
      const output = await until(
        () => jobOutputSince(host, launched.id, { stdout: 0, stderr: 0 }),
        (read) => read.stdout.includes("one"),
      );
      expect(output.stdout).toBe("one\n");
      const running = await until(
        () => jobStatus(host, launched.id),
        (record) => record?.commandPid !== null,
      );
      leftRunning.push(running!.commandPid!);

      const stopped = await requestStop(host, launched.id);
      expect(stopped?.state).toBe("stopped");
      const gone = await until(
        async () => [
          host.subprocess.processState(running!.runnerPid!),
          host.subprocess.processState(running!.commandPid!),
        ],
        (states) => states.every((state) => state === "gone"),
      );
      expect(gone).toEqual(["gone", "gone"]);
    },
    TEST_MS,
  );

  it(
    "whose runner is killed is ended, and its command stopped",
    async () => {
      const host = nodeHost();
      const launched = await launchJob(host, {
        command: "sleep 30",
        label: "sleep",
        cwd: host.system.cwd(),
        maxMs: 60_000,
      });
      leftRunning.push(launched.runnerPid!);
      const running = await until(
        () => jobStatus(host, launched.id),
        (record) => record?.commandPid !== null,
      );
      const commandPid = running!.commandPid!;
      leftRunning.push(commandPid);

      process.kill(launched.runnerPid!, "SIGKILL");
      const ended = await until(
        () => jobStatus(host, launched.id),
        (record) => record?.state !== "running",
      );
      expect(ended).toMatchObject({ state: "ended", note: RUNNER_DIED_STOPPED });
      const commandState = await until(
        async () => host.subprocess.processState(commandPid),
        (state) => state === "gone",
      );
      expect(commandState).toBe("gone");
    },
    TEST_MS,
  );
});
