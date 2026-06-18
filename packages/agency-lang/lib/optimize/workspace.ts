import * as fs from "fs";
import * as path from "path";

import { sha256Text, type OptimizeTargetSet } from "./targets.js";

export type Workspace = { dir: string; key: string };

/**
 * Entries never copied into a workspace fork.
 *
 * `package.json` is excluded deliberately: the generated agent imports the
 * Agency runtime via the bare specifier `agency-lang`, which resolves by
 * self-reference to the *nearest* `package.json` named `agency-lang`. Copying
 * the package's own `package.json` into the workspace would make the workspace
 * that nearest scope — and resolve the runtime to the workspace's (excluded,
 * absent) `dist/`. Leaving it out lets the self-reference climb to the real
 * package root, so the forked agent resolves the runtime exactly as an
 * in-place run does.
 */
const FORK_EXCLUDED = ["node_modules", ".git", "dist", "runs", ".worktrees", "package.json"];

/** Owns per-iteration workspace directories and resolves paths against them. */
export class WorkspaceManager {
  private counter = 0;
  constructor(private readonly rootDir: string) {}

  /**
   * Copy `sourceDir` into a fresh workspace directory, skipping heavy/irrelevant dirs.
   *
   * We copy top-level entries one by one (rather than `cpSync(sourceDir, dir)`)
   * because the runs directory — and thus `dir` itself — usually lives *inside*
   * `sourceDir` (so the forked agent resolves `node_modules` by walking up to the
   * package root). A whole-directory copy would hit Node's "cannot copy into a
   * subdirectory of self" guard. Beyond the static excludes, we also skip the
   * top-level entry that actually contains the workspace root, so any runs-dir
   * name (`runs`, `optimize-runs`, or a custom `--runs-dir`) is handled, not
   * just the literal `runs`.
   */
  fork(sourceDir: string): Workspace {
    this.counter += 1;
    const key = `ws-${this.counter}`;
    const dir = path.join(this.rootDir, key);
    fs.mkdirSync(dir, { recursive: true });
    const containingEntry = this.topLevelEntryContainingRoot(sourceDir);
    for (const entry of fs.readdirSync(sourceDir)) {
      if (FORK_EXCLUDED.includes(entry)) continue;
      if (entry === containingEntry) continue;
      fs.cpSync(path.join(sourceDir, entry), path.join(dir, entry), { recursive: true });
    }
    return { dir, key };
  }

  /**
   * The top-level entry of `sourceDir` whose subtree contains this manager's
   * workspace root, or null when the root lives outside `sourceDir`. Skipping it
   * during a fork prevents copying a directory into its own descendant.
   */
  private topLevelEntryContainingRoot(sourceDir: string): string | null {
    const rel = path.relative(sourceDir, this.rootDir);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep)[0];
  }

  read(ws: Workspace, relPath: string): string {
    return fs.readFileSync(this.resolveWithin(ws, relPath), "utf8");
  }

  write(ws: Workspace, relPath: string, content: string): void {
    const abs = this.resolveWithin(ws, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  /** Resolve `relPath` against the workspace and refuse paths that escape it (`..`, absolute). */
  private resolveWithin(ws: Workspace, relPath: string): string {
    const root = path.resolve(ws.dir);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Path ${JSON.stringify(relPath)} escapes the workspace ${root}`);
    }
    return abs;
  }

  /** Materialize a file map (e.g. OptimizeSourceMutator.preview().files) into the workspace. */
  applyFiles(ws: Workspace, files: Record<string, string>): void {
    for (const [rel, source] of Object.entries(files)) this.write(ws, rel, source);
  }

  /**
   * Write a champion file set back to the original sources, sha-checked: every
   * discovered file must still match its discovery-time hash, or the whole
   * writeback aborts (as PR #283). Only changed files are written.
   */
  writeBack(source: OptimizeTargetSet, championFiles: Record<string, string>): void {
    for (const sf of Object.values(source.files)) {
      if (sha256Text(fs.readFileSync(sf.absoluteFile, "utf8")) !== sf.sha256) {
        throw new Error(`Source file ${sf.absoluteFile} was modified externally; writeback aborted.`);
      }
    }
    for (const [rel, contents] of Object.entries(championFiles)) {
      if (contents !== source.files[rel]?.source) fs.writeFileSync(source.files[rel].absoluteFile, contents);
    }
  }
}
