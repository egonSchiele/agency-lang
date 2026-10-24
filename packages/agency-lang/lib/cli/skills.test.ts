import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { frontmatterParser } from "tarsec/parsers/markdown";
import {
  INSTALL_MARKER,
  findSkills,
  installSkill,
  listSkills,
  renderInstalledFile,
  renderSkillList,
  resolveInstallDir,
  type ShippedSkill,
} from "./skills.js";

const debugRun: ShippedSkill = {
  name: "debug-run",
  description: "Look at a running program: stuck or slow ones",
  text: "---\nname: debug-run\ndescription: Look at a running program\n---\n\nStep one.\n",
  body: "Step one.\n",
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agency-skills-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(dir: string, folder: string, text: string): void {
  fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, folder, "SKILL.md"), text);
}

describe("the shipped skills", () => {
  it("include debug-run and debug-logs, each with a description", () => {
    const skills = listSkills();
    expect(skills.map((skill) => skill.name)).toEqual(["debug-logs", "debug-run"]);
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.body).toContain(
        `agency ${skill.name === "debug-run" ? "debug" : "logs"} session`,
      );
    }
  });

  it("are written for any agent, not only Claude Code", () => {
    for (const skill of listSkills()) {
      expect(skill.text).not.toContain("$ARGUMENTS");
      expect(skill.text).not.toContain("argument-hint");
    }
  });
});

describe("listSkills", () => {
  it("sorts by name and skips a folder with no SKILL.md", () => {
    writeSkill(tmp, "b", "---\nname: b\ndescription: Second\n---\n\nBody b\n");
    writeSkill(tmp, "a", "---\nname: a\ndescription: First\n---\n\nBody a\n");
    fs.mkdirSync(path.join(tmp, "empty"));
    const skills = listSkills(tmp);
    expect(skills.map((skill) => skill.name)).toEqual(["a", "b"]);
    expect(skills[0].body).toBe("Body a\n");
  });

  it("throws when a skill's name does not match its folder", () => {
    writeSkill(tmp, "a", "---\nname: other\ndescription: First\n---\n\nBody\n");
    expect(() => listSkills(tmp)).toThrow(/its folder is a/);
  });

  it("throws when a skill has no description", () => {
    writeSkill(tmp, "a", "---\nname: a\n---\n\nBody\n");
    expect(() => listSkills(tmp)).toThrow(/no description/);
  });
});

describe("renderSkillList", () => {
  it("lines the descriptions up after the longest name", () => {
    const short = { ...debugRun, name: "ab", description: "Short" };
    expect(renderSkillList([debugRun, short])).toBe(
      "debug-run  Look at a running program: stuck or slow ones\nab         Short",
    );
  });
});

describe("findSkills", () => {
  it("names every unknown skill and lists the real ones", () => {
    const lookup = findSkills(["debug-run", "nope", "../x"], [debugRun]);
    expect(lookup).toEqual({
      ok: false,
      text: "No skill named nope, ../x. The skills are: debug-run.",
    });
  });

  it("returns the skills in the order asked", () => {
    const other = { ...debugRun, name: "other" };
    const lookup = findSkills(["other", "debug-run"], [debugRun, other]);
    expect(lookup.ok && lookup.found.map((skill) => skill.name)).toEqual(["other", "debug-run"]);
  });
});

describe("renderInstalledFile", () => {
  it("writes a stub that points at agency skills show", () => {
    const text = renderInstalledFile(debugRun, false);
    expect(text).toContain(INSTALL_MARKER);
    expect(text).toContain("Run `agency skills show debug-run` and follow what it prints.");
    expect(text).not.toContain("Step one.");
  });

  it("writes the whole body with full", () => {
    const text = renderInstalledFile(debugRun, true);
    expect(text).toContain(INSTALL_MARKER);
    expect(text.endsWith("Step one.\n")).toBe(true);
  });

  it("quotes the description so a colon in it still parses", () => {
    const parsed = frontmatterParser(renderInstalledFile(debugRun, false));
    expect(parsed.success && parsed.result.data).toEqual({
      name: "debug-run",
      description: "Look at a running program: stuck or slow ones",
    });
  });
});

describe("resolveInstallDir", () => {
  it("maps each flag to its directory", () => {
    expect(resolveInstallDir({ claude: true }, "/home/u", "/work")).toEqual({
      ok: true,
      dir: "/home/u/.claude/skills",
    });
    expect(resolveInstallDir({ project: true }, "/home/u", "/work")).toEqual({
      ok: true,
      dir: "/work/.claude/skills",
    });
    expect(resolveInstallDir({ dir: "agent/skills" }, "/home/u", "/work")).toEqual({
      ok: true,
      dir: "/work/agent/skills",
    });
  });

  it("refuses no flag and more than one flag", () => {
    expect(resolveInstallDir({}, "/home/u", "/work").ok).toBe(false);
    expect(resolveInstallDir({ claude: true, dir: "x" }, "/home/u", "/work").ok).toBe(false);
  });
});

describe("installSkill", () => {
  const installed = () => path.join(tmp, "debug-run", "SKILL.md");

  it("creates the skill folder and writes the stub", () => {
    const outcome = installSkill(debugRun, tmp, false);
    expect(outcome).toEqual({ ok: true, text: `Installed debug-run at ${installed()}` });
    expect(fs.readFileSync(installed(), "utf8")).toBe(renderInstalledFile(debugRun, false));
  });

  it("replaces a file it wrote before", () => {
    installSkill(debugRun, tmp, false);
    expect(installSkill(debugRun, tmp, true).ok).toBe(true);
    expect(fs.readFileSync(installed(), "utf8")).toContain("Step one.");
  });

  it("leaves alone a file someone else wrote", () => {
    writeSkill(tmp, "debug-run", "my own notes\n");
    const outcome = installSkill(debugRun, tmp, false);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("was not written by agency skills install");
    expect(fs.readFileSync(installed(), "utf8")).toBe("my own notes\n");
  });

  it("refuses a symlinked skill folder", () => {
    fs.mkdirSync(path.join(tmp, "elsewhere"));
    fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(tmp, "debug-run"));
    const outcome = installSkill(debugRun, tmp, false);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("is a symlink");
    expect(fs.readdirSync(path.join(tmp, "elsewhere"))).toEqual([]);
  });

  it("refuses a symlinked SKILL.md, even one pointing at a file it wrote", () => {
    const real = path.join(tmp, "real.md");
    fs.writeFileSync(real, renderInstalledFile(debugRun, false));
    fs.mkdirSync(path.join(tmp, "debug-run"));
    fs.symlinkSync(real, installed());
    const outcome = installSkill(debugRun, tmp, true);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("is a symlink");
    expect(fs.readFileSync(real, "utf8")).not.toContain("Step one.");
  });
});
