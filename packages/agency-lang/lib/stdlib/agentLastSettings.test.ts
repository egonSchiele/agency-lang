import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  LAST_SETTINGS_FILE,
  _readLastSettings,
  _writeLastSettings,
  type LastSettings,
} from "./agentLastSettings.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".last-settings-test-"));
  try {
    await fn(dir);
  } finally {
    expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
  }
}

const VALID: LastSettings = {
  preset: "big",
  choices: { pin: "claude-opus-4-8", slots: { reasoning: "openai/o5" }, effort: "low" },
};

function writeRaw(home: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  fs.writeFileSync(path.join(home, LAST_SETTINGS_FILE), text);
}

describe("the last settings file", () => {
  it("reads back what was written", async () => {
    await withHome(async (home) => {
      expect(await _writeLastSettings(home, VALID)).toBe("");
      expect(await _readLastSettings(home)).toEqual(VALID);
    });
  });

  it("keeps no effort when none was chosen", async () => {
    await withHome(async (home) => {
      const { effort: _effort, ...choices } = VALID.choices;
      await _writeLastSettings(home, { preset: "", choices });
      const read = await _readLastSettings(home);
      expect(read).toEqual({ preset: "", choices });
      expect(read?.choices).not.toHaveProperty("effort");
    });
  });

  it("reads a missing file as null", async () => {
    await withHome(async (home) => {
      expect(await _readLastSettings(home)).toBeNull();
    });
  });

  it("reads a file that isn't JSON as null", async () => {
    await withHome(async (home) => {
      writeRaw(home, "{nope");
      expect(await _readLastSettings(home)).toBeNull();
    });
  });

  it("reads a file of the wrong shape as null", async () => {
    const wrong: unknown[] = [
      { ...VALID, choices: { ...VALID.choices, slots: [] } },
      { ...VALID, choices: { ...VALID.choices, slots: { main: 3 } } },
      { ...VALID, choices: { ...VALID.choices, effort: 4 } },
      { ...VALID, preset: null },
      { preset: "big" },
    ];
    for (const value of wrong) {
      await withHome(async (home) => {
        writeRaw(home, value);
        expect(await _readLastSettings(home)).toBeNull();
      });
    }
  });

  // A hand-edited file can't carry options, such as a server address, or
  // anything else into a run.
  it("drops keys it doesn't know", async () => {
    await withHome(async (home) => {
      writeRaw(home, {
        ...VALID,
        budget: { maxCost: 1 },
        choices: { ...VALID.choices, llmOptions: { baseUrl: { mlx: "https://x" } } },
      });
      expect(await _readLastSettings(home)).toEqual(VALID);
    });
  });

  it("makes the home when it is missing", async () => {
    await withHome(async (dir) => {
      const home = path.join(dir, "home");
      expect(await _writeLastSettings(home, VALID)).toBe("");
      expect(fs.existsSync(path.join(home, LAST_SETTINGS_FILE))).toBe(true);
    });
  });
});
