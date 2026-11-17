import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { nodeHost } from "./nodeHost.js";
import { checkPolicy } from "../../runtime/policy.js";
import { resolvePolicyDirs } from "../../runtime/policyDirs.js";
import { safeDeleteDirectoryWithin } from "../../utils.js";

// A host given a working folder, in a process whose own folder is
// somewhere else. Everything a run measures against "where the program was
// run" must mean the host's folder, and never the process's.

let work: string;
const processFolder = fs.realpathSync(process.cwd());

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agency-host-cwd-")));
  fs.writeFileSync(path.join(work, "notes.txt"), "from the host's folder");
});

afterEach(() => {
  safeDeleteDirectoryWithin(os.tmpdir(), work);
});

const read = (dir: string) => ({
  effect: "std::read",
  message: "m",
  data: { dir, filename: "notes.txt" },
  origin: "std::fs",
});

describe("nodeHost with a working folder", () => {
  it("reports that folder as its cwd", () => {
    expect(nodeHost({ cwd: work }).system.cwd()).toBe(work);
  });

  it("refuses a folder that is not an absolute path, when the host is built", () => {
    expect(() => nodeHost({ cwd: "some/folder" })).toThrow("must be an absolute path");
    expect(() => nodeHost({ cwd: "." })).toThrow("must be an absolute path");
  });

  it("resolves a relative folder and a relative path against it", async () => {
    const { files, system } = nodeHost({ cwd: work });
    expect((await files.root(".")).real).toBe(work);
    expect((await files.fixedRoot("sub")).real).toBe(path.join(work, "sub"));
    expect(await files.realDir("sub")).toBe(path.join(work, "sub"));
    expect(await files.realPath("notes.txt")).toBe(path.join(work, "notes.txt"));
    expect((await files.wholePath("out/a.txt")).root.real).toBe(path.join(work, "out"));
    expect((await files.fixedPath("out/a.txt")).root.real).toBe(path.join(work, "out"));
    expect(system.realDir(".")).toBe(work);
  });

  it("reads the file a relative folder names in its own folder", async () => {
    const { files } = nodeHost({ cwd: work });
    const located = await files.locate(".", "notes.txt", "read");
    expect(located).toEqual({ dir: work, filename: "notes.txt" });
    expect(await files.readText(await files.root("."), "notes.txt")).toBe("from the host's folder");
  });

  it("accepts a folder to be created under it for a write", async () => {
    const { files } = nodeHost({ cwd: work });
    const located = await files.locate("new", "a.txt", "write", true);
    expect(located).toEqual({ dir: path.join(work, "new"), filename: "a.txt" });
  });

  it("leaves an absolute path alone", async () => {
    const { files } = nodeHost({ cwd: work });
    expect((await files.root(os.tmpdir())).real).toBe(fs.realpathSync(os.tmpdir()));
  });

  it("runs a command given no folder in it, and one given a folder there", async () => {
    const { subprocess } = nodeHost({ cwd: work });
    const here = await subprocess.run({ kind: "shell", script: "pwd -P" });
    expect(here.stdout.trim()).toBe(work);
    const elsewhere = await subprocess.run(
      { kind: "shell", script: "pwd -P" },
      { cwd: os.tmpdir() },
    );
    expect(elsewhere.stdout.trim()).toBe(fs.realpathSync(os.tmpdir()));
    const started = await subprocess.start({ kind: "shell", script: "pwd -P" });
    expect((await started.wait()).stdout.trim()).toBe(work);
  });

  // How the stdlib calls it: `exec`, `bash` and a background job always
  // pass a `cwd` key, set to undefined when the caller named no folder.
  it("runs a command in it when the folder is passed as undefined", async () => {
    const { subprocess } = nodeHost({ cwd: work });
    const options = { cwd: undefined, timeoutMs: 10_000 };
    const ran = await subprocess.run({ kind: "shell", script: "pwd -P" }, options);
    expect(ran.stdout.trim()).toBe(work);
    const started = await subprocess.start({ kind: "shell", script: "pwd -P" }, options);
    expect((await started.wait()).stdout.trim()).toBe(work);
  });

  it("is the folder a policy's `.` means", () => {
    const dirs = resolvePolicyDirs(nodeHost({ cwd: work }));
    expect(dirs.cwd).toBe(work);
    const policy = { "std::read": [{ match: { dir: "{.,./**}" }, action: "approve" as const }] };
    expect(checkPolicy(policy, read(work), dirs).type).toBe("approve");
    expect(checkPolicy(policy, read(path.join(work, "src")), dirs).type).toBe("approve");
    // The process's own folder gets nothing from the rule.
    expect(checkPolicy(policy, read(processFolder), dirs).type).toBe("propagate");
  });

  it("gives two hosts in one process their own folders", async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agency-host-cwd-")));
    try {
      fs.writeFileSync(path.join(other, "notes.txt"), "from the other folder");
      const [a, b] = [nodeHost({ cwd: work }), nodeHost({ cwd: other })];
      expect(await a.files.readText(await a.files.root("."), "notes.txt")).toBe(
        "from the host's folder",
      );
      expect(await b.files.readText(await b.files.root("."), "notes.txt")).toBe(
        "from the other folder",
      );
      expect([a.system.cwd(), b.system.cwd()]).toEqual([work, other]);
    } finally {
      safeDeleteDirectoryWithin(os.tmpdir(), other);
    }
  });
});

describe("nodeHost with no working folder", () => {
  it("uses the process's folder, as before", async () => {
    const { files, system, subprocess } = nodeHost();
    expect(system.cwd()).toBe(process.cwd());
    expect((await files.root(".")).real).toBe(processFolder);
    expect(system.realDir(".")).toBe(processFolder);
    const here = await subprocess.run({ kind: "shell", script: "pwd -P" });
    expect(here.stdout.trim()).toBe(processFolder);
    expect(resolvePolicyDirs(nodeHost()).cwd).toBe(processFolder);
  });
});
