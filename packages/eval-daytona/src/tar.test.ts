import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { expect, it } from "vitest";

import { tarDirectory, untarGz } from "./tar.js";

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tar-test-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function filesIn(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

it("leaves the excluded folders out, at the top and below it", () => {
  const dir = tree({
    "node_modules/x/index.js": "x",
    ".git/HEAD": "ref",
    "src/z.ts": "z",
    "src/node_modules/kept.js": "nested folders of the same name are not excluded",
    "runs/tonight/a/statelog.jsonl": "{}",
    "runs/other/b.txt": "b",
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tar-out-"));
  execFileSync("tar", ["-xf", "-", "-C", out], { input: tarDirectory(dir, ["node_modules", ".git", "runs/tonight"]) });
  expect(filesIn(out)).toEqual(["runs/other/b.txt", "src/node_modules/kept.js", "src/z.ts"]);
});

it("packs everything when nothing is excluded", () => {
  const dir = tree({ "a.txt": "a", "sub/b.txt": "b" });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tar-out-"));
  execFileSync("tar", ["-xf", "-", "-C", out], { input: tarDirectory(dir) });
  expect(filesIn(out)).toEqual(["a.txt", "sub/b.txt"]);
});

it("unpacks a gzipped tar", () => {
  const dir = tree({ "statelog.jsonl": "{}\n", "graders/g.json": "[]" });
  const archive = execFileSync("tar", ["-czf", "-", "-C", dir, "."]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tar-out-"));
  untarGz(archive, out);
  expect(filesIn(out)).toEqual(["graders/g.json", "statelog.jsonl"]);
});
