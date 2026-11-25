import type { Host, Root } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { isPlainObject } from "../utils/isPlainObject.js";

/**
 * The settings a new agent session starts with: the preset, models and
 * effort the person last chose, in any session. The agent writes
 * them after a model, effort or preset change, and reads them when a run
 * names no preset, model or effort flag. See "The last settings" in
 * docs/dev/agents/agent-presets.md.
 *
 * Like the saved sessions in `agentSessions.ts`, this is harness
 * bookkeeping in the agent's own home, not a tool: it raises no
 * interrupt. Only a person's answer causes a write, and what is kept is
 * names the start checks again. A front-end such as Perry's onboarding
 * may write it too.
 */

/** The stored part of a session's model choices (`ModelChoices` in
 *  `lib/agents/agency-agent/lib/modelRequest.agency`). Never its
 *  `llmOptions`: they can name a server. */
export type LastChoices = { pin: string; slots: Record<string, string>; effort?: string };

/** What a new session starts with. `preset` is a saved preset's name, or
 *  "" for none. */
export type LastSettings = { preset: string; choices: LastChoices };

export const LAST_SETTINGS_FILE = "last-settings.json";

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** The choices in `value`, rebuilt from the known fields only, or null
 *  when a field has the wrong type. */
function choicesIn(value: unknown): LastChoices | null {
  if (!isPlainObject(value) || typeof value.pin !== "string" || !isStringRecord(value.slots)) {
    return null;
  }
  if (value.effort !== undefined && typeof value.effort !== "string") {
    return null;
  }
  const choices: LastChoices = { pin: value.pin, slots: { ...value.slots } };
  return value.effort === undefined ? choices : { ...choices, effort: value.effort };
}

function lastSettingsIn(value: unknown): LastSettings | null {
  if (!isPlainObject(value) || typeof value.preset !== "string") {
    return null;
  }
  const choices = choicesIn(value.choices);
  return choices === null ? null : { preset: value.preset, choices };
}

async function readJson(host: Host, dir: Root, name: string): Promise<unknown> {
  try {
    if ((await host.files.stat(dir, name)) === null) return null;
    return JSON.parse(await host.files.readText(dir, name));
  } catch {
    return null;
  }
}

/** The last settings in `home`, or null when there are none or the file
 *  is not what this module writes. */
export async function _readLastSettings(home: string): Promise<LastSettings | null> {
  const host = currentHost();
  return lastSettingsIn(await readJson(host, await host.files.root(home), LAST_SETTINGS_FILE));
}

/** Writes the last settings into `home`, made first when it is missing.
 *  Returns "" on success, else the error message. */
export async function _writeLastSettings(home: string, settings: LastSettings): Promise<string> {
  const host = currentHost();
  try {
    const root = await host.files.root(home);
    await host.files.mkdir(root, ".");
    // writeText renames a finished sibling over the target, so a crash
    // mid-write never leaves a half-written file.
    await host.files.writeText(root, LAST_SETTINGS_FILE, JSON.stringify(settings));
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
