import type { Host, OperatingSystem } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { ProgramFailed, program, runProgram } from "./abortable.js";

const DEFAULT_SERVICE = "agency-lang";

/** Whether `secret-tool`, the Secret Service client, is the keyring to
 *  use. WSL is Linux here: the tool runs inside it as on any Linux. */
function usesSecretTool(os: OperatingSystem): boolean {
  return os === "linux" || os === "wsl";
}

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
    // On stdin, not in the arguments, which any user can read with `ps`.
    // `-U` replaces an existing item in place, so a failed store keeps the
    // old value.
    const command = securityCommandLine([
      "add-generic-password",
      "-U",
      "-s",
      svc,
      "-a",
      key,
      "-w",
      value,
    ]);
    await runProgram(host, "security", ["-i"], { input: `${command}\n` });
  } else if (usesSecretTool(os)) {
    const result = await host.subprocess.run(
      program("secret-tool", ["store", "--label", `${svc}:${key}`, "service", svc, "account", key]),
      { input: value },
    );
    if (result.exitCode !== 0) {
      throw new Error(`secret-tool store failed with exit code ${result.exitCode}`);
    }
  } else {
    throw unsupported(os);
  }
}

function unsupported(os: OperatingSystem): Error {
  return new Error(
    `System keyring is not supported on ${os}. ` +
      `Set the AGENCY_OAUTH_KEY environment variable instead.`,
  );
}

/** One line for `security -i`, which reads one command per line. Every
 *  argument is in double quotes, where `\"` is a quote and `\\` a
 *  backslash; `$` and spaces need nothing. A line break would end the
 *  command early, so an argument with one is refused. */
export function securityCommandLine(args: string[]): string {
  if (args.some((arg) => /[\n\r\0]/.test(arg))) {
    throw new Error("Keyring values must be one line.");
  }
  return args.map((arg) => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" ");
}

/** The text whose UTF-8 bytes `hex` spells. */
function utf8FromHex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** The password from `security find-generic-password -g`'s stderr, or null
 *  when it printed none. `-g` prints `password: "plain"` for printable
 *  ASCII with no quote or backslash, and `password: 0x<HEX>  "…"` for
 *  anything else, so the hex form is the one to decode. (`-w` prints hex
 *  for such values with nothing to say so, and can't be read back.) */
export function passwordFromSecurityOutput(stderr: string): string | null {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith("password: "));
  if (line === undefined) {
    return null;
  }
  const hex = /^password: 0x([0-9A-Fa-f]+)/.exec(line);
  if (hex) {
    return utf8FromHex(hex[1]);
  }
  const plain = /^password: "(.*)"$/.exec(line);
  return plain ? plain[1] : null;
}

/** What a keyring lookup found. `unavailable`: this system has no keyring
 *  this module supports, or its command isn't installed. `failed`: the
 *  keyring is there but couldn't be read (locked, refused, timed out). */
export type SecretLookup =
  | { kind: "found"; value: string }
  | { kind: "missing" }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

/** `security`'s exit code for an item that doesn't exist. */
const SECURITY_ITEM_NOT_FOUND = 44;

function isNotInstalled(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** A missing item: `security` exits 44; `secret-tool` exits 1 and prints
 *  nothing. */
function isMissing(command: string, error: ProgramFailed): boolean {
  if (command === "security") {
    return error.exitCode === SECURITY_ITEM_NOT_FOUND;
  }
  return error.exitCode === 1 && error.stdout === "" && error.stderr.trim() === "";
}

function lookupFailure(command: string, error: unknown): SecretLookup {
  if (isNotInstalled(error)) {
    return { kind: "unavailable", reason: `\`${command}\` isn't installed.` };
  }
  if (error instanceof ProgramFailed && isMissing(command, error)) {
    return { kind: "missing" };
  }
  return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
}

async function readFromKeychain(args: {
  host: Host;
  service: string;
  key: string;
  timeoutMs: number | undefined;
}): Promise<SecretLookup> {
  try {
    const { stderr } = await lookup(
      args.host,
      "security",
      ["find-generic-password", "-s", args.service, "-a", args.key, "-g"],
      args.timeoutMs,
    );
    const value = passwordFromSecurityOutput(stderr);
    return value === null
      ? { kind: "failed", reason: "security printed no password." }
      : { kind: "found", value };
  } catch (error) {
    return lookupFailure("security", error);
  }
}

async function readFromSecretTool(args: {
  host: Host;
  service: string;
  key: string;
  timeoutMs: number | undefined;
}): Promise<SecretLookup> {
  try {
    const { stdout } = await lookup(
      args.host,
      "secret-tool",
      ["lookup", "service", args.service, "account", args.key],
      args.timeoutMs,
    );
    return { kind: "found", value: stdout.trimEnd() };
  } catch (error) {
    return lookupFailure("secret-tool", error);
  }
}

/**
 * Look a secret up, saying whether it was found, is missing, or couldn't be
 * read. `timeoutMs` bounds the lookup: a locked keychain waits on a prompt,
 * and a broken Secret Service backend can hang. A lookup stopped at the
 * deadline is `failed`. Unset means no bound.
 */
export async function readSecret(
  host: Host,
  key: string,
  service?: string,
  timeoutMs?: number,
): Promise<SecretLookup> {
  if (!key) throw new Error("Keyring key must not be empty.");
  const args = { host, service: service || DEFAULT_SERVICE, key, timeoutMs };
  const os = host.system.operatingSystem();
  if (os === "macos") {
    return readFromKeychain(args);
  }
  if (usesSecretTool(os)) {
    return readFromSecretTool(args);
  }
  return { kind: "unavailable", reason: unsupported(os).message };
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
 * Retrieve a secret from the system keyring: the value, or null when it
 * doesn't exist. Throws when the keyring couldn't be read (locked,
 * refused, timed out, or no keyring here), so the Agency-facing
 * `getSecret` fails rather than reporting the secret missing.
 */
export async function _getSecret(
  key: string,
  service?: string,
  timeoutMs?: number,
): Promise<string | null> {
  const found = await readSecret(currentHost(), key, service, timeoutMs);
  switch (found.kind) {
    case "found":
      return found.value;
    case "missing":
      return null;
    case "unavailable":
    case "failed":
      throw new Error(found.reason);
  }
}

/** A secret for a TypeScript caller that has the host: the value, or null
 *  when nothing usable was found, whether missing or unreadable. Throws on
 *  a system with no supported keyring. Use `readSecret` to tell those
 *  apart. */
export async function getSecret(
  host: Host,
  key: string,
  service?: string,
  timeoutMs?: number,
): Promise<string | null> {
  const os = host.system.operatingSystem();
  if (os !== "macos" && !usesSecretTool(os)) {
    throw unsupported(os);
  }
  const found = await readSecret(host, key, service, timeoutMs);
  return found.kind === "found" ? found.value : null;
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
  } else if (usesSecretTool(os)) {
    try {
      await runProgram(host, "secret-tool", ["clear", "service", svc, "account", key]);
      return true;
    } catch {
      return false;
    }
  } else {
    throw unsupported(os);
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
  } else if (usesSecretTool(os)) {
    try {
      await runProgram(host, "secret-tool", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
