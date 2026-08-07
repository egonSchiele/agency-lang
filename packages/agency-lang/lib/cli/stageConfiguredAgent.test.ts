import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { stageConfiguredAgent } from "./stageConfiguredAgent.js";

// A minimal agent dir: source, a relative Agency import, and pre-existing
// compiled artifacts standing in for the shipped agent.js and its deps.
function makeAgentDir(root: string): string {
  const dir = path.join(root, "agent-src");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "lib", "greet.agency"),
    'export def greet(): string {\n  return "hi"\n}\n',
  );
  fs.writeFileSync(
    path.join(dir, "agent.agency"),
    'import { greet } from "./lib/greet.agency"\n\nnode main() {\n  print(greet())\n}\n',
  );
  fs.writeFileSync(path.join(dir, "agent.js"), "// shipped agent\n");
  fs.writeFileSync(path.join(dir, "lib", "greet.js"), "// shipped dependency\n");
  return dir;
}

function fileHashes(directory: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else {
        hashes[path.relative(directory, fullPath)] = createHash("sha256")
          .update(fs.readFileSync(fullPath))
          .digest("hex");
      }
    }
  };
  visit(directory);
  return hashes;
}

function makeReadOnly(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      makeReadOnly(fullPath);
      fs.chmodSync(fullPath, 0o555);
    } else {
      fs.chmodSync(fullPath, 0o444);
    }
  }
  fs.chmodSync(directory, 0o555);
}

function makeWritable(directory: string): void {
  fs.chmodSync(directory, 0o755);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      makeWritable(fullPath);
    } else {
      fs.chmodSync(fullPath, 0o644);
    }
  }
}

describe("stageConfiguredAgent", () => {
  let cleanupFns: Array<() => void> = [];
  let fixtureRoots: string[] = [];
  afterEach(() => {
    cleanupFns.forEach((cleanup) => cleanup());
    for (const root of fixtureRoots) {
      makeWritable(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
    cleanupFns = [];
    fixtureRoots = [];
  });

  function freshRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-"));
    fixtureRoots.push(root);
    return root;
  }

  test("compiles in a temp tree; a baked config field reaches the output", () => {
    const root = freshRoot();
    const agentDir = makeAgentDir(root);
    const cfg = path.join(root, "agency.json");
    fs.writeFileSync(
      cfg,
      JSON.stringify({ client: { defaultModel: "openai/sentinel-staged" } }),
    );
    const { runFile, cleanup } = stageConfiguredAgent(cfg, agentDir);
    cleanupFns.push(cleanup);
    expect(fs.readFileSync(runFile, "utf8")).toContain("sentinel-staged");
    expect(runFile.startsWith(agentDir)).toBe(false);
  });

  test("the staged tree is owner-only: 0700 root, 0600 generated run file", () => {
    // The staged agent.js can bake credentials from the explicit config and
    // lives for the child's lifetime; on a shared machine it must not be
    // group/world readable.
    const root = freshRoot();
    const agentDir = makeAgentDir(root);
    const cfg = path.join(root, "agency.json");
    fs.writeFileSync(cfg, "{}");
    const { runFile, cleanup } = stageConfiguredAgent(cfg, agentDir);
    cleanupFns.push(cleanup);
    const stageRoot = path.dirname(runFile);
    expect(fs.statSync(stageRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(runFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(stageRoot, "lib")).mode & 0o777).toBe(0o700);
  });

  test("leaves the source tree byte-for-byte unchanged, even when read-only", () => {
    const root = freshRoot();
    const agentDir = makeAgentDir(root);
    const cfg = path.join(root, "agency.json");
    fs.writeFileSync(cfg, "{}");
    const before = fileHashes(agentDir);
    makeReadOnly(agentDir);
    const { cleanup } = stageConfiguredAgent(cfg, agentDir);
    cleanupFns.push(cleanup);
    makeWritable(agentDir);
    expect(fileHashes(agentDir)).toEqual(before);
  });

  test("ignores outDir from the user config", () => {
    const root = freshRoot();
    const agentDir = makeAgentDir(root);
    const userOut = path.join(root, "user-out");
    const cfg = path.join(root, "agency.json");
    fs.writeFileSync(cfg, JSON.stringify({ outDir: userOut }));
    const { cleanup } = stageConfiguredAgent(cfg, agentDir);
    cleanupFns.push(cleanup);
    expect(fs.existsSync(userOut)).toBe(false);
  });

  test("cleanup removes the staged tree", () => {
    const root = freshRoot();
    const agentDir = makeAgentDir(root);
    const cfg = path.join(root, "agency.json");
    fs.writeFileSync(cfg, "{}");
    const { runFile, cleanup } = stageConfiguredAgent(cfg, agentDir);
    cleanup();
    expect(fs.existsSync(runFile)).toBe(false);
  });

  test("malformed config throws before any temp tree is created", () => {
    const root = freshRoot();
    const agentDir = makeAgentDir(root);
    const cfg = path.join(root, "agency.json");
    fs.writeFileSync(cfg, "{not json");
    const ownedStages = () =>
      fs.readdirSync(root).filter((name) => name.startsWith("agency-agent-"));
    expect(ownedStages()).toEqual([]);
    expect(() => stageConfiguredAgent(cfg, agentDir, { tempRoot: root })).toThrow();
    expect(ownedStages()).toEqual([]);
  });

  test("a nonexistent explicit config path throws instead of building empty", () => {
    const root = freshRoot();
    const agentDir = makeAgentDir(root);
    expect(() =>
      stageConfiguredAgent(path.join(root, "no-such.json"), agentDir),
    ).toThrow(/no-such\.json/);
  });

  test("cleanup unregisters the process exit listener", () => {
    const root = freshRoot();
    const agentDir = makeAgentDir(root);
    const cfg = path.join(root, "agency.json");
    fs.writeFileSync(cfg, "{}");
    const listenerCount = process.listenerCount("exit");
    const { cleanup } = stageConfiguredAgent(cfg, agentDir);
    expect(process.listenerCount("exit")).toBe(listenerCount + 1);
    cleanup();
    expect(process.listenerCount("exit")).toBe(listenerCount);
    cleanup(); // idempotent
    expect(process.listenerCount("exit")).toBe(listenerCount);
  });

  test("simultaneous configured stages clean up independently", () => {
    const root = freshRoot();
    const agentDir = makeAgentDir(root);
    const firstConfig = path.join(root, "first.json");
    const secondConfig = path.join(root, "second.json");
    fs.writeFileSync(
      firstConfig,
      JSON.stringify({ client: { defaultModel: "openai/first" } }),
    );
    fs.writeFileSync(
      secondConfig,
      JSON.stringify({ client: { defaultModel: "openai/second" } }),
    );
    const first = stageConfiguredAgent(firstConfig, agentDir);
    const second = stageConfiguredAgent(secondConfig, agentDir);
    cleanupFns.push(first.cleanup, second.cleanup);
    expect(path.dirname(first.runFile)).not.toBe(path.dirname(second.runFile));
    expect(fs.readFileSync(first.runFile, "utf8")).toContain("first");
    expect(fs.readFileSync(second.runFile, "utf8")).toContain("second");
    first.cleanup();
    expect(fs.existsSync(first.runFile)).toBe(false);
    expect(fs.existsSync(second.runFile)).toBe(true);
  });
});
