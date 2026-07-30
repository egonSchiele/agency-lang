import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

export type ParsedSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; subdir?: string; ref?: string; display: string };

export type ResolvedSource = { dir: string; sha?: string; display: string };

const REF_SEPARATOR = "?ref=";
/** 24 hex chars of the (url, ref) hash: collision-safe for a local cache while
 *  keeping directory names readable. */
const CACHE_KEY_LENGTH = 24;
const DEFAULT_CACHE_ROOT = path.join(os.homedir(), ".agency", "cache", "git");

function looksLikeGitUrl(candidate: string): boolean {
  return candidate.startsWith("git@") || candidate.includes("://")
    || /^github\.com\//.test(candidate) || candidate.endsWith(".git");
}

/** Peel `?ref=<rev>` off the end. */
function splitRef(raw: string): { base: string; ref?: string } {
  const separatorIndex = raw.indexOf(REF_SEPARATOR);
  if (separatorIndex === -1) {
    return { base: raw };
  }
  const ref = raw.slice(separatorIndex + REF_SEPARATOR.length);
  if (ref === "") {
    throw new Error(`Source ${raw}: ?ref= is empty`);
  }
  return { base: raw.slice(0, separatorIndex), ref };
}

/** Peel `//subdir` off, skipping a scheme's own "//". */
function splitSubdir(base: string): { base: string; subdir?: string } {
  const schemeEnd = base.indexOf("://");
  const searchFrom = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const separatorIndex = base.indexOf("//", searchFrom);
  if (separatorIndex === -1) {
    return { base };
  }
  const subdir = base.slice(separatorIndex + 2);
  return { base: base.slice(0, separatorIndex), subdir: subdir === "" ? undefined : subdir };
}

/** The clone URL: a local repo path resolved, a schemeless github.com form
 *  given its scheme, a GitHub https URL given its .git suffix. */
function cloneUrl(base: string, baseDir: string): string {
  const withScheme = /^github\.com\//.test(base) ? `https://${base}` : base;
  const resolved = looksLikeGitUrl(withScheme) ? withScheme : path.resolve(baseDir, withScheme);
  return /^https:\/\/github\.com\//.test(resolved) && !resolved.endsWith(".git")
    ? `${resolved}.git`
    : resolved;
}

/** Parse `local path | git URL [//subdir] [?ref=rev]`. A local path WITH ?ref=
 *  is a git source that clones from that path. */
export function parseSource(raw: string, baseDir: string): ParsedSource {
  const { base: withoutRef, ref } = splitRef(raw);
  if (ref === undefined && !looksLikeGitUrl(withoutRef)) {
    return { kind: "local", path: path.resolve(baseDir, withoutRef) };
  }
  const { base, subdir } = splitSubdir(withoutRef);
  return { kind: "git", url: cloneUrl(base, baseDir), subdir, ref, display: raw };
}

/** The eval layer's one git invoker. Not stdlib's _gitRun: that is async
 *  (this path must stay synchronous for loadInputs) and stdlib support code
 *  should not be imported upward into the eval layer. */
function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function looksLikeSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(ref);
}

/**
 * Resolve a parsed source to a local directory, plus the resolved sha for git
 * sources. One checkout per (url, ref) under cacheRoot: a sha entry never
 * refetches; a branch/tag/default entry re-fetches per call.
 */
export function resolveSource(parsed: ParsedSource, opts: { cacheRoot?: string } = {}): ResolvedSource {
  if (parsed.kind === "local") {
    return { dir: parsed.path, display: parsed.path };
  }

  const cacheRoot = opts.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const cacheKey = crypto.createHash("sha256")
    .update(`${parsed.url}\n${parsed.ref ?? ""}`)
    .digest("hex")
    .slice(0, CACHE_KEY_LENGTH);
  const cacheDir = path.join(cacheRoot, cacheKey);
  const pinnedToSha = parsed.ref !== undefined && looksLikeSha(parsed.ref);

  if (!fs.existsSync(cacheDir)) {
    materialize(parsed, cacheDir, cacheRoot);
  } else if (!pinnedToSha) {
    try {
      git(["fetch", "--depth", "1", "origin", parsed.ref ?? "HEAD"], cacheDir);
      git(["reset", "--hard", "FETCH_HEAD"], cacheDir);
    } catch (err) {
      throw sourceError(parsed, err);
    }
  }

  const sha = git(["rev-parse", "HEAD"], cacheDir);
  const dir = parsed.subdir ? path.join(cacheDir, parsed.subdir) : cacheDir;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Source ${parsed.display}: subdir "${parsed.subdir}" does not exist at ${sha.slice(0, 12)}`);
  }
  return { dir, sha, display: parsed.display };
}

/** Clone into a temp sibling, then atomically rename into place. Two runs
 *  racing on the same (url, ref) both succeed: the loser discards its clone. */
function materialize(parsed: ParsedSource & { kind: "git" }, cacheDir: string, cacheRoot: string): void {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const tempDir = `${cacheDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (parsed.ref !== undefined && looksLikeSha(parsed.ref)) {
      fs.mkdirSync(tempDir, { recursive: true });
      git(["init", "-q"], tempDir);
      git(["remote", "add", "origin", parsed.url], tempDir);
      try {
        git(["fetch", "--depth", "1", "origin", parsed.ref], tempDir);
      } catch (shallowErr) {
        // Some servers refuse arbitrary-sha fetches (GitHub allows them).
        // Fall back to a full fetch — but keep the original reason visible in
        // case the full fetch fails for the same underlying problem.
        console.warn(`[sources] shallow sha fetch failed for ${parsed.display}; retrying with a full fetch ` +
          `(${shallowErr instanceof Error ? shallowErr.message.split("\n")[0] : String(shallowErr)})`);
        git(["fetch", "origin"], tempDir);
      }
      git(["checkout", "-q", parsed.ref], tempDir);
    } else {
      const branchArgs = parsed.ref !== undefined ? ["--branch", parsed.ref] : [];
      git(["clone", "-q", "--depth", "1", ...branchArgs, parsed.url, tempDir]);
    }
    try {
      fs.renameSync(tempDir, cacheDir);
    } catch (renameErr) {
      const code = (renameErr as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") {
        throw renameErr;
      }
      // Lost the race: someone else materialized the same (url, ref).
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw sourceError(parsed, err);
  }
}

function sourceError(parsed: ParsedSource & { kind: "git" }, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`Failed to resolve source ${parsed.display} (url=${parsed.url}, ref=${parsed.ref ?? "(default)"}): ${detail}`);
}
