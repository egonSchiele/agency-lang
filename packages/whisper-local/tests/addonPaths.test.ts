import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import {
  addonFileName,
  currentAddonTarget,
  resolveAddonDir,
  resolveAddonPath,
} from "../src/addonPaths.js";

describe("resolveAddonDir", () => {
  const origEnv = process.env.AGENCY_WHISPER_ADDON_DIR;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AGENCY_WHISPER_ADDON_DIR;
    else process.env.AGENCY_WHISPER_ADDON_DIR = origEnv;
  });

  it("lives beside the models under the home directory by default", () => {
    delete process.env.AGENCY_WHISPER_ADDON_DIR;
    expect(resolveAddonDir()).toBe(path.join(os.homedir(), ".agency/addons/whisper"));
  });

  it("honours the environment override", () => {
    process.env.AGENCY_WHISPER_ADDON_DIR = "/tmp/addons";
    expect(resolveAddonDir()).toBe("/tmp/addons");
  });
});

describe("addonFileName", () => {
  it("names the build by everything the binary depends on", () => {
    expect(
      addonFileName({ packageVersion: "0.0.3", platform: "darwin", arch: "arm64", abi: "137" }),
    ).toBe("whisper_addon-0.0.3-darwin-arm64-abi137.node");
  });

  it("reads the running process for the current target", () => {
    const target = currentAddonTarget("1.2.3");
    expect(target).toEqual({
      packageVersion: "1.2.3",
      platform: process.platform,
      arch: process.arch,
      abi: process.versions.modules,
    });
    expect(resolveAddonPath(target, "/x")).toBe(`/x/${addonFileName(target)}`);
  });
});
