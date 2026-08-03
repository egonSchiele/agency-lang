import { describe, it, expect, vi } from "vitest";
import { confirmDeployWithoutExports } from "./confirmation.js";

describe("confirmDeployWithoutExports", () => {
  it("proceeds without prompting on a dry run", async () => {
    const prompt = vi.fn();
    expect(await confirmDeployWithoutExports({ dryRun: true, isTty: true, prompt })).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("proceeds without prompting when stdin is not a TTY", async () => {
    const prompt = vi.fn();
    expect(await confirmDeployWithoutExports({ isTty: false, prompt })).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts on an interactive TTY and returns its answer", async () => {
    expect(await confirmDeployWithoutExports({ isTty: true, prompt: async () => true })).toBe(true);
    expect(await confirmDeployWithoutExports({ isTty: true, prompt: async () => false })).toBe(false);
  });
});
