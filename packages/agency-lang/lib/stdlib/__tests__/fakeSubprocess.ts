// A stand-in for the subprocess part of the host, for the tests of helpers
// that run a fixed program such as osascript or security. Each test mocks
// lib/host/nodeSubprocess.ts with `vi.mock` and then reads what was run
// and scripts what it answers through these.
import { vi } from "vitest";
import type { Command, RunResult } from "../../host/host.js";

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
