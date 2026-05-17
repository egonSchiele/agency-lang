import * as path from "path";
import { fileURLToPath } from "url";

export type InstallKind = "global" | "local" | "workspace";

// Substrings that strongly indicate a global install. Order does not matter.
// Use forward-slash forms; we normalize input before matching so Windows
// backslashes are also handled.
const GLOBAL_MARKERS = [
  "/lib/node_modules/", // npm unix (default prefix)
  "/pnpm/global/", // pnpm global store
  "/npm/node_modules/", // npm windows (AppData/Roaming/npm/node_modules)
  "/.npm-global/", // custom npm prefix in $HOME
  "/.volta/tools/", // volta-managed tool installs
  "/.fnm/node-versions/", // fnm-managed Node with global packages
  "/.nvm/versions/node/", // nvm-managed Node with global packages
  "/_npx/", // npx / npm exec ephemeral installs; the spawned `node
  // <user-file>` runs in the user's cwd which has no
  // path to this _npx tree, so this is effectively a
  // global-install scenario for the purposes of the
  // resolver-shim warning.
];

function toPosix(p: string): string {
  // Normalize both backslashes and forward slashes regardless of host OS,
  // so a Windows-style path string still classifies correctly on a unix host
  // (relevant for tests and for log/diagnostic output).
  return p.replace(/\\/g, "/");
}

export function classifyInstall(installDir: string): InstallKind {
  const norm = toPosix(installDir);
  if (GLOBAL_MARKERS.some((m) => norm.includes(m))) return "global";
  // A project-local install always sits under .../node_modules/agency-lang
  if (norm.includes("/node_modules/agency-lang")) return "local";
  return "workspace";
}

export function installDirFromUrl(metaUrl: string): string {
  // The CLI entry lives at dist/scripts/agency.js. Walk up two directories
  // to get the package's install root (the directory containing package.json).
  const file = fileURLToPath(metaUrl);
  return path.resolve(path.dirname(file), "..", "..");
}
