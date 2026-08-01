// ─────────────────────────────────────────────────────────────────────────
// PROTOTYPE — `agency deploy` (upload-only). THROWAWAY. Not wired into the CLI.
//
// Question this answers: what should `agency deploy <file>` feel like, and what
// are the load-bearing decisions before we write the real command —
//   (1) where the target (host / project / api key) comes from,
//   (2) how multi-file agents (imports) are handled,
//   (3) whether the api key is reused from agency.json or read from an env var,
//   (4) how much the CLI hardcodes statelog's upload API.
//
// Deploy needs nothing from agency-lang internals: the statelog upload endpoint
// compiles server-side and takes raw source, and fills in the user from the API
// key. So this is: read agency.json `log` → read the .agency source → POST to
// `/api/projects/:project/upload` → print the returned /serve URLs.
//
// Run (defaults to a dry-run — prints the plan, sends nothing):
//   node scripts/deploy-prototype.ts <file.agency> [flags]
//   node scripts/deploy-prototype.ts <file.agency> --execute      # actually POST
// Flags: --host URL  --project SLUG  --api-key-env NAME  --config PATH  --execute
// ─────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

// ── ANSI (throwaway styling) ────────────────────────────────────────────────
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// ═════════════════════════════════════════════════════════════════════════
// PORTABLE LOGIC (pure) — this is the bit worth lifting into lib/cli/deploy.ts.
// No I/O, no console, no process. Takes plain data in, returns plain data out.
// ═════════════════════════════════════════════════════════════════════════

type DeployTarget = { host: string; projectId: string; apiKey: string };
type DeployFile = { name: string; contents: string };
type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

/** Where each field of the target came from — surfaced in the UI so the user
 *  can see the resolution, and a decision point in itself (see notes). */
type TargetSource = { host: string; projectId: string; apiKey: string };

const DEFAULT_HOST = "http://localhost:1065";

/**
 * Resolve the deploy target. Precedence per field: explicit flag > agency.json
 * `log.*` > env fallback. The api key is deliberately env-first (never a flag,
 * to keep it out of argv/process listings) but may also sit in agency.json.
 */
function resolveTarget(input: {
  agencyLog: { host?: string; projectId?: string; apiKey?: string };
  hostFlag?: string;
  projectFlag?: string;
  apiKeyEnvName?: string;
  env: Record<string, string | undefined>;
}): Resolved<{ target: DeployTarget; source: TargetSource }> {
  const { agencyLog, hostFlag, projectFlag, apiKeyEnvName, env } = input;

  const host = hostFlag ?? agencyLog.host ?? DEFAULT_HOST;
  const hostSrc = hostFlag
    ? "--host"
    : agencyLog.host
      ? "agency.json log.host"
      : `default ${DEFAULT_HOST}`;

  const projectId = projectFlag ?? agencyLog.projectId;
  const projectSrc = projectFlag ? "--project" : "agency.json log.projectId";

  // Env-first: an explicit --api-key-env wins; otherwise agency.json log.apiKey;
  // otherwise the conventional STATELOG_API_KEY.
  let apiKey: string | undefined;
  let apiKeySrc: string;
  if (apiKeyEnvName) {
    apiKey = env[apiKeyEnvName];
    apiKeySrc = `$${apiKeyEnvName}`;
  } else if (agencyLog.apiKey) {
    apiKey = agencyLog.apiKey;
    apiKeySrc = "agency.json log.apiKey";
  } else {
    apiKey = env.STATELOG_API_KEY;
    apiKeySrc = "$STATELOG_API_KEY";
  }

  const missing: string[] = [];
  if (!projectId) missing.push("project (set log.projectId or pass --project)");
  if (!apiKey) missing.push(`api key (set ${apiKeySrc} or pass --api-key-env)`);
  if (missing.length > 0) {
    return { ok: false, error: `Missing: ${missing.join("; ")}` };
  }

  return {
    ok: true,
    value: {
      target: { host, projectId: projectId!, apiKey: apiKey! },
      source: { host: hostSrc, projectId: projectSrc, apiKey: apiKeySrc },
    },
  };
}

/** Agency `import`s that point at a local file (surfaces the multi-file
 *  question: this prototype uploads a single file, so any local import is a
 *  dangling reference the server won't resolve). Std/pkg imports are ignored. */
function localImports(source: string): string[] {
  const found: string[] = [];
  const re = /\bimport\b[^\n]*?from\s+["'](\.[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) found.push(m[1]);
  return found;
}

/** Build the upload HTTP request (pure). Path segments are encoded, though the
 *  project slug is already constrained server-side. */
function buildUploadRequest(
  target: DeployTarget,
  files: DeployFile[],
): { url: string; method: "POST"; headers: Record<string, string>; body: string } {
  const url = new URL(
    `/api/projects/${encodeURIComponent(target.projectId)}/upload`,
    target.host,
  ).toString();
  return {
    url,
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files }),
  };
}

/** Interpret statelog's `Result<{ endpointUrls }>` response into absolute URLs
 *  (the server returns them host-relative). */
function interpretResponse(
  status: number,
  json: unknown,
  host: string,
): Resolved<{ urls: string[] }> {
  const body = json as
    | { success: true; value: { endpointUrls: string[] } }
    | { success: false; error: string }
    | undefined;
  if (!body) return { ok: false, error: `HTTP ${status}: empty/invalid body` };
  if (body.success === false) return { ok: false, error: body.error };
  const urls = (body.value?.endpointUrls ?? []).map((u) =>
    new URL(u, host).toString(),
  );
  return { ok: true, value: { urls } };
}

// ═════════════════════════════════════════════════════════════════════════
// THROWAWAY CLI SHELL — arg parsing, file I/O, fetch, rendering. Not for prod.
// ═════════════════════════════════════════════════════════════════════════

type Flags = {
  file?: string;
  host?: string;
  project?: string;
  apiKeyEnv?: string;
  config?: string;
  execute: boolean;
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") f.execute = true;
    else if (a === "--host") f.host = argv[++i];
    else if (a === "--project") f.project = argv[++i];
    else if (a === "--api-key-env") f.apiKeyEnv = argv[++i];
    else if (a === "--config") f.config = argv[++i];
    else if (!a.startsWith("-") && !f.file) f.file = a;
  }
  return f;
}

/** Nearest agency.json walking up from `startDir` (or an explicit path). */
function findAgencyJson(startDir: string, explicit?: string): string | undefined {
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, "agency.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function redactKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

function fail(msg: string): never {
  console.error(`\n${red("✗")} ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.log(`\n${bold("agency deploy")} ${dim("(PROTOTYPE — upload only)")}\n`);

  if (!flags.file) fail("Usage: node scripts/deploy-prototype.ts <file.agency> [--execute]");
  const filePath = path.resolve(flags.file);
  if (!fs.existsSync(filePath)) fail(`File not found: ${filePath}`);
  if (!filePath.endsWith(".agency")) fail(`Not an .agency file: ${filePath}`);

  // agency.json → log section
  const agencyJsonPath = findAgencyJson(path.dirname(filePath), flags.config);
  let agencyLog: { host?: string; projectId?: string; apiKey?: string } = {};
  if (agencyJsonPath) {
    try {
      agencyLog = (JSON.parse(fs.readFileSync(agencyJsonPath, "utf-8")).log ?? {});
    } catch (e) {
      fail(`Could not parse ${agencyJsonPath}: ${(e as Error).message}`);
    }
  }

  const resolved = resolveTarget({
    agencyLog,
    hostFlag: flags.host,
    projectFlag: flags.project,
    apiKeyEnvName: flags.apiKeyEnv,
    env: process.env,
  });
  if (!resolved.ok) fail(resolved.error);
  const { target, source } = resolved.value;

  const contents = fs.readFileSync(filePath, "utf-8");
  const files: DeployFile[] = [{ name: path.basename(filePath), contents }];
  const imports = localImports(contents);

  // ── Render state ──────────────────────────────────────────────────────────
  console.log(bold("Target"));
  console.log(`  ${dim("host   ")} ${target.host}          ${dim(source.host)}`);
  console.log(`  ${dim("project")} ${target.projectId}     ${dim(source.projectId)}`);
  console.log(`  ${dim("api key")} ${redactKey(target.apiKey)}          ${dim(source.apiKey)}`);
  console.log(
    `  ${dim("config ")} ${agencyJsonPath ?? dim("(none found — using flags/env/defaults)")}`,
  );

  console.log(`\n${bold(`Files (${files.length})`)}`);
  for (const fl of files) {
    console.log(`  ${cyan(fl.name)}   ${dim(`${Buffer.byteLength(fl.contents)} bytes`)}`);
  }
  if (imports.length > 0) {
    console.log(
      `\n${yellow("⚠")} ${path.basename(filePath)} imports ${imports
        .map((i) => `"${i}"`)
        .join(", ")} ${dim("— not uploaded (single-file prototype).")}`,
    );
    console.log(
      dim("   Open decision: resolve + upload local imports, or require a bundle?"),
    );
  }

  const req = buildUploadRequest(target, files);
  console.log(`\n${bold("Request")}`);
  console.log(`  ${green(req.method)} ${req.url}`);
  console.log(`  ${dim("Authorization:")} Bearer ${redactKey(target.apiKey)}`);
  console.log(`  ${dim("body:")} { files: [${files.map((f) => f.name).join(", ")}] }`);

  if (!flags.execute) {
    console.log(`\n${yellow("dry-run")} — nothing sent. Re-run with ${bold("--execute")} to deploy.\n`);
    return;
  }

  // ── Execute ─────────────────────────────────────────────────────────────
  console.log(`\n${dim("sending…")}`);
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  } catch (e) {
    fail(`Request failed: ${(e as Error).message}  ${dim("(is statelog running at " + target.host + "?)")}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    fail(`HTTP ${res.status}: response was not JSON`);
  }

  const interp = interpretResponse(res.status, json, target.host);
  if (!interp.ok) fail(`Upload rejected: ${interp.error}`);

  console.log(`\n${green("✓ deployed")}  ${dim(path.basename(filePath))}\n`);
  console.log(bold("Serve endpoints"));
  if (interp.value.urls.length === 0) {
    console.log(dim("  (no exported nodes — nothing to run)"));
  }
  for (const u of interp.value.urls) {
    const label = u.includes("/list") ? dim("manifest") : dim("run node ");
    console.log(`  ${label} ${u}`);
  }
  console.log();
}

main();
