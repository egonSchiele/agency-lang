import { describe, it, expect, vi } from "vitest";

const promptsMock = vi.hoisted(() => vi.fn());
vi.mock("prompts", () => ({ default: promptsMock }));

import { confirmDeployWithoutExports, promptSecretValue } from "./confirmation.js";

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

describe("promptSecretValue", () => {
  it("uses the invisible prompt type", async () => {
    promptsMock.mockResolvedValue({ value: "typed" });
    await expect(promptSecretValue("OPENAI_API_KEY")).resolves.toBe("typed");
    expect(promptsMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "invisible", name: "value" }),
    );
  });

  it("preserves an empty entry as '' (distinct from cancel)", async () => {
    promptsMock.mockResolvedValue({ value: "" });
    await expect(promptSecretValue("N")).resolves.toBe("");
  });

  it("normalizes cancellation (missing answer key) to undefined", async () => {
    promptsMock.mockResolvedValue({});
    await expect(promptSecretValue("N")).resolves.toBeUndefined();
  });

  it("renders a control-character name terminal-safe in the message", async () => {
    promptsMock.mockResolvedValue({ value: "v" });
    await promptSecretValue("BAD\x1b[31mNAME");
    const message = (promptsMock.mock.calls.at(-1)![0] as { message: string }).message;
    expect(message).toContain(JSON.stringify("BAD\x1b[31mNAME"));
    expect(message).not.toContain("\x1b");
  });
});
