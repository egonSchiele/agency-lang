import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const generatedHelpersPath = fileURLToPath(
  new URL("../templates/backends/typescriptGenerator/imports.ts", import.meta.url),
);

describe("generated TypeScript helpers", () => {
  const generatedHelpers = readFileSync(generatedHelpersPath, "utf8");

  it("does not add a mutable trace-directory setter", () => {
    expect(generatedHelpers).not.toContain("__setTraceDir");
  });

  it("forwards invocation config and external signals on interrupt resume", () => {
    const respondToInterruptsLine = generatedHelpers
      .split("\n")
      .find((line) => line.startsWith("export const respondToInterrupts ="));

    expect(respondToInterruptsLine).toContain("abortSignal: opts?.abortSignal");
    expect(respondToInterruptsLine).toContain("pauseSignal: opts?.pauseSignal");
    expect(respondToInterruptsLine).toContain("invocation: opts?.invocation");
  });
});
