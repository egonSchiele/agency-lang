// A stand-in for the subprocess part of the host, for the tests of helpers
// that run a fixed program such as osascript or security. Each test mocks
// lib/host/nodeSubprocess.ts with `vi.mock` and then reads what was run
// and scripts what it answers through these.
import { vi } from "vitest";
import type { Command, Host, OperatingSystem, RunResult } from "../../host/host.js";
import { nodeHost } from "../../host/nodeHost.js";

/** The operating system `hostOn` and `testDefaultHost` report. A test that
 *  needs the macOS branch, or the refusal on another system, sets it. */
export const testPlatform = { os: "macos" as OperatingSystem };

/** A node host that reports `os` as its operating system. */
export function hostOn(os: OperatingSystem): Host {
  const real = nodeHost();
  return { ...real, system: { ...real.system, operatingSystem: () => os } };
}

/** The platform's default host for a test file that mocks `#default-host`
 *  with `vi.mock("#default-host", () => ({ defaultHost: testDefaultHost }))`:
 *  a node host reporting `testPlatform.os`, so a helper that reads
 *  `currentHost()` outside a run sees the operating system the test set. */
export function testDefaultHost(): Host {
  return hostOn(testPlatform.os);
}

type MockFn = ReturnType<typeof vi.fn>;

/** A child that exited with 0 and printed `stdout`. */
export function exited(stdout = "", stderr = ""): RunResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr,
    truncated: null,
    timedOut: false,
    aborted: false,
  };
}

/** A child that exited with `exitCode` and printed `stderr`. */
export function failed(stderr = "", exitCode: number | null = 1): RunResult {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr,
    truncated: null,
    timedOut: false,
    aborted: false,
  };
}

/** The program and arguments of the `index`th call to the mocked `run`. */
export function programRun(run: unknown, index = 0): { program: string; args: string[] } {
  const command = (run as MockFn).mock.calls[index][0] as Command;
  if (command.kind !== "program") {
    throw new Error("expected a program, got a shell script");
  }
  return { program: command.program, args: command.args };
}
