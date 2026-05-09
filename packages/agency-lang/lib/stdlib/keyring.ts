import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const DEFAULT_SERVICE = "agency-lang";

/**
 * Store a secret in the system keyring.
 * macOS: Keychain via `security` CLI
 * Linux: Secret Service via `secret-tool` CLI
 */
export async function _setSecret(key: string, value: string, service?: string): Promise<void> {
  if (!key) throw new Error("Keyring key must not be empty.");
  if (!value) throw new Error("Keyring value must not be empty.");
  const svc = service || DEFAULT_SERVICE;

  if (process.platform === "darwin") {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-s", svc,
        "-a", key,
      ]);
    } catch {}

    await execFileAsync("security", [
      "add-generic-password",
      "-s", svc,
      "-a", key,
      "-w", value,
      "-U",
    ]);
  } else if (process.platform === "linux") {
    const child = spawn("secret-tool", [
      "store",
      "--label", `${svc}:${key}`,
      "service", svc,
      "account", key,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    child.stdin.write(value);
    child.stdin.end();

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`secret-tool store failed with exit code ${code}`));
      });
      child.on("error", reject);
    });
  } else {
    throw new Error(
      `System keyring is not supported on ${process.platform}. ` +
      `Set the AGENCY_OAUTH_KEY environment variable instead.`
    );
  }
}

/**
 * Retrieve a secret from the system keyring.
 * Returns null if the secret doesn't exist.
 */
export async function _getSecret(key: string, service?: string): Promise<string | null> {
  if (!key) throw new Error("Keyring key must not be empty.");
  const svc = service || DEFAULT_SERVICE;

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s", svc,
        "-a", key,
        "-w",
      ]);
      return stdout.trimEnd();
    } catch {
      return null;
    }
  } else if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("secret-tool", [
        "lookup",
        "service", svc,
        "account", key,
      ]);
      return stdout.trimEnd();
    } catch {
      return null;
    }
  } else {
    throw new Error(
      `System keyring is not supported on ${process.platform}. ` +
      `Set the AGENCY_OAUTH_KEY environment variable instead.`
    );
  }
}

/**
 * Delete a secret from the system keyring.
 * Returns true if the secret was deleted, false if it didn't exist.
 */
export async function _deleteSecret(key: string, service?: string): Promise<boolean> {
  if (!key) throw new Error("Keyring key must not be empty.");
  const svc = service || DEFAULT_SERVICE;

  if (process.platform === "darwin") {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-s", svc,
        "-a", key,
      ]);
      return true;
    } catch {
      return false;
    }
  } else if (process.platform === "linux") {
    try {
      await execFileAsync("secret-tool", [
        "clear",
        "service", svc,
        "account", key,
      ]);
      return true;
    } catch {
      return false;
    }
  } else {
    throw new Error(
      `System keyring is not supported on ${process.platform}. ` +
      `Set the AGENCY_OAUTH_KEY environment variable instead.`
    );
  }
}

/**
 * Check if the system keyring is available on this platform.
 */
export async function _isKeyringAvailable(): Promise<boolean> {
  if (process.platform === "darwin") {
    try {
      await execFileAsync("security", ["help"]);
      return true;
    } catch {
      return false;
    }
  } else if (process.platform === "linux") {
    try {
      await execFileAsync("secret-tool", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
