import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { expect, it } from "vitest";

import { containerEnv, evalSettings, OPTIONS_FILE, readOptions } from "./options.js";

function project(options?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-daytona-options-"));
  if (options !== undefined) {
    fs.writeFileSync(path.join(dir, OPTIONS_FILE), JSON.stringify(options));
  }
  return dir;
}

it("gives the defaults when the project has no options file", () => {
  expect(readOptions(project())).toEqual({
    image: "node:22-bookworm",
    cpu: 4,
    memory: 8,
    disk: 10,
    env: [],
    set: {},
    agency: "same",
    graceSec: 7200,
  });
});
it("overrides only what the file names", () => {
  const options = readOptions(project({ image: "x", env: ["K"], agency: { tarball: "a.tgz" } }));
  expect(options).toMatchObject({ image: "x", env: ["K"], agency: { tarball: "a.tgz" }, cpu: 4 });
});
it("refuses an unknown key by name, and a value of the wrong kind", () => {
  expect(() => readOptions(project({ imagee: "x" }))).toThrow(/eval-daytona\.json.*imagee/s);
  expect(() => readOptions(project({ agency: { tarball: 5 } }))).toThrow(/eval-daytona\.json/);
  expect(() => readOptions(project({ cpu: 0 }))).toThrow(/eval-daytona\.json/);
});
it("refuses a file that is not JSON, naming it", () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, OPTIONS_FILE), "{ image: ");
  expect(() => readOptions(dir)).toThrow(/eval-daytona\.json is not valid JSON/);
});

it("passes the named host variables that are set, and lists the ones that are not", () => {
  expect(containerEnv({ fixed: {}, names: ["A", "B"], pairs: [], hostEnv: { A: "1", C: "3" } })).toEqual({
    values: { A: "1" },
    missing: ["B"],
  });
});
it("puts --env pairs on top, splitting at the first =", () => {
  expect(containerEnv({ fixed: {}, names: ["A"], pairs: ["A=2", "C=x=y", "EMPTY="], hostEnv: { A: "1" } })).toEqual({
    values: { A: "2", C: "x=y", EMPTY: "" },
    missing: [],
  });
});
it("never looks up a pair's name on the host", () => {
  const result = containerEnv({ fixed: {}, names: [], pairs: ["ORACLE=1"], hostEnv: { ORACLE: "leaked" } });
  expect(result.values).toEqual({ ORACLE: "1" });
});
it("does not read a host variable that only a pair could have set", () => {
  expect(containerEnv({ fixed: {}, names: [], pairs: [], hostEnv: { ORACLE: "leaked" } }).values).toEqual({});
});
it("refuses a pair with no = or no name, naming it", () => {
  expect(() => containerEnv({ fixed: {}, names: [], pairs: ["NOEQUALS"], hostEnv: {} })).toThrow('--env NOEQUALS');
  expect(() => containerEnv({ fixed: {}, names: [], pairs: ["=x"], hostEnv: {} })).toThrow("--env =x");
  expect(() => containerEnv({ fixed: {}, names: [], pairs: ["BAD-NAME=x"], hostEnv: {} })).toThrow("--env BAD-NAME=x");
});

it("refuses an env name that is not a variable name, naming it", () => {
  expect(() => readOptions(project({ env: ["MY KEY"] }))).toThrow(/eval-daytona\.json[\s\S]*env/);
});

it("reads the eval settings the wrapper needs from the config agency prints", () => {
  expect(
    evalSettings({ eval: { runsDir: "out", limits: { maxBatchCostUsd: 5, wallClockSec: 7200 } } }),
  ).toEqual({ runsDir: "out", maxBatchCostUsd: 5, wallClockSec: 7200 });
  expect(evalSettings({})).toEqual({ runsDir: "runs" });
});

it("reads fixed values from set, and refuses a bad name there", () => {
  expect(readOptions(project({ set: { CI: "true" } })).set).toEqual({ CI: "true" });
  expect(readOptions(project({})).set).toEqual({});
  expect(() => readOptions(project({ set: { "MY KEY": "x" } }))).toThrow(/eval-daytona\.json[\s\S]*set/);
});

it("puts fixed values over host variables and under --env pairs, never reading the host for them", () => {
  const result = containerEnv({
    names: ["A"],
    fixed: { A: "fixed", CI: "true", B: "fixed" },
    pairs: ["B=pair"],
    hostEnv: { A: "host", CI: "leaked" },
  });
  expect(result).toEqual({ values: { A: "fixed", CI: "true", B: "pair" }, missing: [] });
});
