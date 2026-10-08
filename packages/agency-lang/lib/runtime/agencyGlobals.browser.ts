// The free names Agency code may use that come from the platform, for a
// browser bundle: `path` is the portable path module behind #path, and
// `os` answers the two questions Agency code asks of it from the default
// host. Node's entry point exports Node's own modules instead
// (agencyGlobals.node.ts).
import { defaultHost } from "#default-host";
import portablePath from "#path";

export const path = portablePath;

export const os = {
  homedir: (): string => defaultHost().system.homeDir(),
  tmpdir: (): string => defaultHost().system.tempDir(),
  platform: (): string => defaultHost().system.operatingSystem(),
};
