// Model API keys kept in the system keyring. A key lives under the service
// "agency-lang", with its environment variable's name as the account, so a
// key saved once (by Perry, or with `security add-generic-password`) serves
// every program that loads it. Loading fills in only the variables the
// environment leaves unset: the keyring is one more place a variable can
// come from. See docs/dev/agents/agent-presets.md, "Keys from the keychain".
import type { Host, HostEnv } from "../host/host.js";
import { PROVIDER_KEY_VARIABLES } from "../runtime/llmClient.js";
import { readSecret, setSecret, type SecretLookup } from "./keyring.js";

export const API_KEY_SERVICE = "agency-lang";

/** How long one lookup may take: a locked keychain waits on a prompt, and
 *  a broken Secret Service can hang, and a command can't start on either. */
const LOOKUP_TIMEOUT_MS = 2000;

/** The variables a model API key is read from, in `PROVIDER_KEY_VARIABLES`'
 *  order. */
export function apiKeyVariables(): string[] {
  return Object.values(PROVIDER_KEY_VARIABLES);
}

/** What `loadApiKeys` set, and why it stopped, if a lookup failed. */
export type LoadedApiKeys = { loaded: string[]; failed: string | null };

const NOTHING: LoadedApiKeys = { loaded: [], failed: null };

/** Secret Service runs on the D-Bus session bus. With none, `secret-tool`
 *  can only hang until the timeout, on every start. GLib finds the bus
 *  through `DBUS_SESSION_BUS_ADDRESS`, or `$XDG_RUNTIME_DIR/bus` when that
 *  is unset (tmux, SSH, WSL with systemd), so only both missing means no
 *  bus. */
function hasNoSecretService(host: Host): boolean {
  const os = host.system.operatingSystem();
  return (
    (os === "linux" || os === "wsl") &&
    !host.env.get("DBUS_SESSION_BUS_ADDRESS") &&
    !host.env.get("XDG_RUNTIME_DIR")
  );
}

/**
 * Fill in each API key variable the environment leaves unset, from the
 * keyring. The first lookup runs alone: a locked keychain or a missing
 * command shows up there, so it asks at most once. The rest then run at
 * the same time. A keyring that isn't there (no supported system, no
 * command, no D-Bus session) reads nothing and reports nothing.
 */
export async function loadApiKeys(args: {
  host: Host;
  timeoutMs?: number;
}): Promise<LoadedApiKeys> {
  const { host } = args;
  const timeoutMs = args.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const unset = apiKeyVariables().filter((variable) => !host.env.get(variable));
  if (unset.length === 0 || hasNoSecretService(host)) {
    return NOTHING;
  }
  const read = (variable: string): Promise<SecretLookup> =>
    readSecret(host, variable, API_KEY_SERVICE, timeoutMs);
  const [first, ...rest] = unset;
  const firstLookup = await read(first);
  if (firstLookup.kind === "failed") {
    return { loaded: [], failed: firstLookup.reason };
  }
  if (firstLookup.kind === "unavailable") {
    return NOTHING;
  }
  const lookups = [firstLookup, ...(await Promise.all(rest.map(read)))];
  const loaded: string[] = [];
  let failed: string | null = null;
  for (const [index, lookup] of lookups.entries()) {
    if (lookup.kind === "found") {
      host.env.set(unset[index], lookup.value);
      loaded.push(unset[index]);
    } else if (lookup.kind === "failed" && failed === null) {
      failed = lookup.reason;
    }
  }
  return { loaded, failed };
}

/** The line to warn with after `loadApiKeys`, or null. It only matters when
 *  a lookup failed and the program now has no key at all: then it says
 *  why the program will find none. */
export function keychainWarning(args: { result: LoadedApiKeys; env: HostEnv }): string | null {
  const { result, env } = args;
  if (result.failed === null || apiKeyVariables().some((variable) => env.get(variable))) {
    return null;
  }
  return `Couldn't read API keys from the keychain: ${result.failed}`;
}

/** Save a model API key in the keyring, where `loadApiKeys` finds it. */
export async function saveApiKey(args: {
  host: Host;
  variable: string;
  value: string;
}): Promise<void> {
  if (!apiKeyVariables().includes(args.variable)) {
    throw new Error(`Not an API key variable: ${args.variable}`);
  }
  await setSecret(args.host, args.variable, args.value, API_KEY_SERVICE);
}
