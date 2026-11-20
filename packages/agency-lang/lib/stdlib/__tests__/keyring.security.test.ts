// The real `security`, on macOS only: what `securityCommandLine` quotes is
// what the keychain stores, and `passwordFromSecurityOutput` reads it back
// exactly. Mocks can't prove either. The test makes its own keychain file
// in a temporary folder and deletes it; it never touches the login
// keychain, and never locks its own, which would open a password prompt.
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { passwordFromSecurityOutput, securityCommandLine } from "../keyring.js";

function security(args: string[], input?: string): { status: number | null; stderr: string } {
  const result = spawnSync("security", args, { input, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

describe.runIf(process.platform === "darwin")("security, for real", () => {
  it("stores and returns exactly the value securityCommandLine quotes", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agency-keyring-"));
    const keychain = path.join(folder, "test.keychain-db");
    try {
      expect(security(["create-keychain", "-p", "test", keychain]).status).toBe(0);
      expect(security(["unlock-keychain", "-p", "test", keychain]).status).toBe(0);
      const values = [`it's a "key" \\ with $HOME and ünïcode`, "-starts-with-a-dash", "616263"];
      values.forEach((value, index) => {
        const account = `k${index}`;
        const line = securityCommandLine([
          "add-generic-password",
          "-U",
          "-s",
          "agency-lang-test",
          "-a",
          account,
          "-w",
          value,
          keychain,
        ]);
        expect(security(["-i"], `${line}\n`).status).toBe(0);
        const read = security([
          "find-generic-password",
          "-s",
          "agency-lang-test",
          "-a",
          account,
          "-g",
          keychain,
        ]);
        expect(read.status).toBe(0);
        expect(passwordFromSecurityOutput(read.stderr)).toBe(value);
      });
    } finally {
      security(["delete-keychain", keychain]);
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
