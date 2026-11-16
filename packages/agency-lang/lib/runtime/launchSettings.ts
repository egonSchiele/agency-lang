// What the command line told this process about how it was started: its
// title, its seed messages, and its output file (docs/dev/runtime/spawn.md).
// They arrive as environment variables, and are taken out of the
// environment as soon as they are read. Left there, every process this one
// starts would inherit them: a shell job that runs a compiled Agency
// program would be seeded with this program's conversation.

import { AGENCY_OUTPUT_FILE, AGENCY_PROCESS_TITLE, AGENCY_SEED_MESSAGES } from "../constants.js";
import { processSlot } from "./processSlot.js";

export type LaunchSettings = {
  /** The title `ps` shows, or null. */
  title: string | null;
  /** Where the seed messages are: a path, or `-` for standard input. Null
   *  when there is none, and once the seed has been taken. */
  seedMessages: string | null;
  /** The file a detached program's output is saved to, or null. */
  outputFile: string | null;
};

const settings = processSlot<LaunchSettings>("agency.launchSettings", () => ({
  title: null,
  seedMessages: null,
  outputFile: null,
}));

function take(variable: string): string | null {
  const value = process.env[variable];
  delete process.env[variable];
  return value === undefined || value === "" ? null : value;
}

/** Read the launch settings from the environment, remove them from it, and
 *  keep them for this process. Called once, by the command-line entry. */
export function takeLaunchSettings(): LaunchSettings {
  settings.set({
    title: take(AGENCY_PROCESS_TITLE),
    seedMessages: take(AGENCY_SEED_MESSAGES),
    outputFile: take(AGENCY_OUTPUT_FILE),
  });
  return settings.get();
}

/** The launch settings this process took, or all nulls for a process the
 *  command line did not start. */
export function launchSettings(): LaunchSettings {
  return settings.get();
}

/** The seed's source, the first time it is asked for, and null after. */
export function takeSeedSource(): string | null {
  const current = settings.get();
  settings.set({ ...current, seedMessages: null });
  return current.seedMessages;
}
