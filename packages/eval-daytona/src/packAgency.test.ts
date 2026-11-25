import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { expect, it } from "vitest";

import { packInstalledAgency } from "./packAgency.js";

function projectWithAgency(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-daytona-pack-"));
  const installed = path.join(dir, "node_modules", "agency-lang");
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "agency-lang", version: "9.9.9" }));
  fs.writeFileSync(path.join(installed, "index.js"), "");
  return dir;
}

it("packs the agency-lang installed in the project into the destination", { timeout: 60_000 }, () => {
  const project = projectWithAgency();
  const dest = path.join(project, "out", "pack");
  const tarball = packInstalledAgency(project, dest);
  expect(path.dirname(tarball)).toBe(dest);
  const manifest = execFileSync("tar", ["-xzOf", tarball, "package/package.json"]).toString();
  expect(JSON.parse(manifest)).toMatchObject({ name: "agency-lang", version: "9.9.9" });
  // nothing was written beside the installed package
  expect(fs.readdirSync(path.join(project, "node_modules", "agency-lang")).sort()).toEqual(["index.js", "package.json"]);
});

it("says what to do when the project has no agency-lang", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-daytona-pack-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  expect(() => packInstalledAgency(dir, path.join(dir, "out"))).toThrow(/agency-lang is not installed in/);
});
