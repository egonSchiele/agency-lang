import type { Host } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { program, runProgram } from "./abortable.js";

const DEFAULT_SERVICE = "agency-lang";

/**
 * Store a secret in the system keyring.
 * macOS: Keychain via `security` CLI
 * Linux: Secret Service via `secret-tool` CLI
 */
export async function _setSecret(key: string, value: string, service?: string): Promise<void> {
  const host = currentHost();
  return setSecret(host, key, value, service);
}

/** `_setSecret` for a caller that has the host. */
export async function setSecret(
  host: Host,
  key: string,
  value: string,
  service?: string,
): Promise<void> {
  if (!key) throw new Error("Keyring key must not be empty.");
  if (!value) throw new Error("Keyring value must not be empty.");
  const svc = service || DEFAULT_SERVICE;
  const os = host.system.operatingSystem();

  if (os === "macos") {
    try {
      await runProgram(host, "security", ["delete-generic-password", "-s", svc, "-a", key]);
    } catch {}

    await runProgram(host, "security", [
      "add-generic-password",
      "-s",
      svc,
      "-a",
      key,
      "-w",
      value,
      "-U",
    ]);
  } else if (os === "linux") {
    const result = await host.subprocess.run(
      program("secret-tool", ["store", "--label", `${svc}:${key}`, "service", svc, "account", key]),
      { input: value },
    );
    if (result.exitCode !== 0) {
      throw new Error(`secret-tool store failed with exit code ${result.exitCode}`);
    }
  } else {
    throw new Error(
      `System keyring is not supported on ${os}. ` +
        `Set the AGENCY_OAUTH_KEY environment variable instead.`,
    );
  }
}

/** Run a lookup command, bounded by `timeoutMs` when one is given. */
function lookup(
  host: Host,
  command: string,
  args: string[],
  timeoutMs: number | undefined,
): Promise<{ stdout: string; stderr: string }> {
  return runProgram(host, command, args, { timeoutMs });
}

/**
 * Retrieve a secret from the system keyring.
 * Returns null if the secret doesn't exist.
 *
 * `timeoutMs` bounds the lookup: a locked keychain can pop a prompt and a
 * broken Secret Service backend can hang, and a caller on a request path
 * cannot wait on either. When the child is killed at the deadline the
 * lookup reads as a miss. Unset means no bound, the historical behavior.
 */
export async function _getSecret(
  key: string,
  service?: string,
  timeoutMs?: number,
): Promise<string | null> {
  const host = currentHost();
  return getSecret(host, key, service, timeoutMs);
}

/** `_getSecret` for a caller that has the host. */
export async function getSecret(
  host: Host,
  key: string,
  service?: string,
  timeoutMs?: number,
): Promise<string | null> {
  if (!key) throw new Error("Keyring key must not be empty.");
  const svc = service || DEFAULT_SERVICE;
  const os = host.system.operatingSystem();

  if (os === "macos") {
    try {
      const { stdout } = await lookup(
        host,
        "security",
        ["find-generic-password", "-s", svc, "-a", key, "-w"],
        timeoutMs,
      );
      return stdout.trimEnd();
    } catch {
      return null;
    }
  } else if (os === "linux") {
    try {
      const { stdout } = await lookup(
        host,
        "secret-tool",
        ["lookup", "service", svc, "account", key],
        timeoutMs,
      );
      return stdout.trimEnd();
    } catch {
      return null;
    }
  } else {
    throw new Error(
      `System keyring is not supported on ${os}. ` +
        `Set the AGENCY_OAUTH_KEY environment variable instead.`,
    );
  }
}

/**
 * Delete a secret from the system keyring.
 * Returns true if the secret was deleted, false if it didn't exist.
 */
export async function _deleteSecret(key: string, service?: string): Promise<boolean> {
  const host = currentHost();
  return deleteSecret(host, key, service);
}

/** `_deleteSecret` for a caller that has the host. */
export async function deleteSecret(host: Host, key: string, service?: string): Promise<boolean> {
  if (!key) throw new Error("Keyring key must not be empty.");
  const svc = service || DEFAULT_SERVICE;
  const os = host.system.operatingSystem();

  if (os === "macos") {
    try {
      await runProgram(host, "security", ["delete-generic-password", "-s", svc, "-a", key]);
      return true;
    } catch {
      return false;
    }
  } else if (os === "linux") {
    try {
      await runProgram(host, "secret-tool", ["clear", "service", svc, "account", key]);
      return true;
    } catch {
      return false;
    }
  } else {
    throw new Error(
      `System keyring is not supported on ${os}. ` +
        `Set the AGENCY_OAUTH_KEY environment variable instead.`,
    );
  }
}

/**
 * Check if the system keyring is available on this platform.
 */
export async function _isKeyringAvailable(): Promise<boolean> {
  const host = currentHost();
  return isKeyringAvailable(host);
}

/** `_isKeyringAvailable` for a caller that has the host. */
export async function isKeyringAvailable(host: Host): Promise<boolean> {
  const os = host.system.operatingSystem();
  if (os === "macos") {
    try {
      await runProgram(host, "security", ["help"]);
      return true;
    } catch {
      return false;
    }
  } else if (os === "linux") {
    try {
      await runProgram(host, "secret-tool", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
