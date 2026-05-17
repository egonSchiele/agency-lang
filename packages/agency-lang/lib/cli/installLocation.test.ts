import { describe, it, expect } from "vitest";
import {
  classifyInstall,
  installDirFromUrl,
  nodeModulesParent,
} from "./installLocation.js";

describe("classifyInstall", () => {
  it("flags npm global paths on unix", () => {
    expect(
      classifyInstall("/usr/local/lib/node_modules/agency-lang/dist/scripts"),
    ).toBe("global");
  });
  it("flags npm prefix global paths on macOS homebrew", () => {
    expect(
      classifyInstall(
        "/opt/homebrew/lib/node_modules/agency-lang/dist/scripts",
      ),
    ).toBe("global");
  });
  it("flags pnpm global paths", () => {
    expect(
      classifyInstall(
        "/home/x/.local/share/pnpm/global/5/node_modules/agency-lang/dist/scripts",
      ),
    ).toBe("global");
  });
  it("flags Windows npm global", () => {
    expect(
      classifyInstall(
        "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\agency-lang\\dist\\scripts",
      ),
    ).toBe("global");
  });
  it("treats project-local installs as local", () => {
    expect(
      classifyInstall("/Users/x/proj/node_modules/agency-lang/dist/scripts"),
    ).toBe("local");
  });
  it("treats workspace dev path as workspace", () => {
    expect(
      classifyInstall(
        "/Users/x/agency-lang/packages/agency-lang/dist/scripts",
      ),
    ).toBe("workspace");
  });
});

describe("installDirFromUrl", () => {
  it("walks up two dirs from dist/scripts/agency.js", () => {
    const url = "file:///opt/x/agency-lang/dist/scripts/agency.js";
    expect(installDirFromUrl(url)).toBe("/opt/x/agency-lang");
  });
});

describe("nodeModulesParent", () => {
  it("returns the parent of agency-lang when inside node_modules", () => {
    expect(nodeModulesParent("/usr/lib/node_modules/agency-lang")).toBe(
      "/usr/lib/node_modules",
    );
  });
  it("falls back to the install dir's own node_modules for workspace dev", () => {
    expect(nodeModulesParent("/repo/packages/agency-lang")).toBe(
      "/repo/packages/agency-lang/node_modules",
    );
  });
});
