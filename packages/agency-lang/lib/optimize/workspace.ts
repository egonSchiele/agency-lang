import * as fs from "fs";
import * as path from "path";

export type Workspace = { dir: string; key: string };

/** Owns per-iteration workspace directories and resolves paths against them. */
export class WorkspaceManager {
  private counter = 0;
  constructor(private readonly rootDir: string) {}

  /** Copy `sourceDir` into a fresh workspace directory. */
  fork(sourceDir: string): Workspace {
    this.counter += 1;
    const key = `ws-${this.counter}`;
    const dir = path.join(this.rootDir, key);
    fs.cpSync(sourceDir, dir, { recursive: true });
    return { dir, key };
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
}
