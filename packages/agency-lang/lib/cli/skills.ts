import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { frontmatterParser } from "tarsec/parsers/markdown";
import { getPackageRoot } from "@/importPaths.js";

/** A skill that ships in the package, under `skills/<name>/SKILL.md`. */
export type ShippedSkill = {
  name: string;
  description: string;
  /** The file's text, frontmatter included. */
  text: string;
  /** The text after the frontmatter. */
  body: string;
};

/** The start of a line `install` puts in every file it writes. A file
 *  without it was written by someone else, so `install` leaves it alone.
 *  Never change this text: files written by older versions are recognized
 *  by it. The rest of the line can change. */
export const INSTALL_MARKER_PREFIX = "<!-- Written by `agency skills install`.";
const INSTALL_MARKER = `${INSTALL_MARKER_PREFIX} Run it again to refresh this file. -->`;

export type InstallTargetFlags = {
  claude?: boolean;
  project?: boolean;
  dir?: string;
};

export type Outcome = { ok: true; text: string } | { ok: false; text: string };

/** Where the skills live: in the repo and in an npm install alike, they
 *  sit at the package root, next to `package.json`. */
export function shippedSkillsDir(): string {
  return path.join(getPackageRoot(), "skills");
}

/**
 * Every skill in `dir`, sorted by name. A folder without a SKILL.md is
 * skipped. A SKILL.md whose frontmatter has no description, or names a
 * different skill than its folder, is a packaging mistake, so it throws.
 */
export function listSkills(dir: string = shippedSkillsDir()): ShippedSkill[] {
  const folders = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const skills: ShippedSkill[] = [];
  for (const folder of folders) {
    const file = path.join(dir, folder, "SKILL.md");
    if (!fs.existsSync(file)) {
      continue;
    }
    skills.push(readSkill(folder, file));
  }
  return skills;
}

function readSkill(folder: string, file: string): ShippedSkill {
  const text = fs.readFileSync(file, "utf8");
  const parsed = frontmatterParser(text);
  if (!parsed.success) {
    throw new Error(`${file} has no frontmatter.`);
  }
  const { name, description } = parsed.result.data;
  if (name !== folder) {
    throw new Error(
      `${file} says its name is ${JSON.stringify(name)}, but its folder is ${folder}.`,
    );
  }
  if (typeof description !== "string" || description === "") {
    throw new Error(`${file} has no description.`);
  }
  return { name, description, text, body: parsed.rest.replace(/^\n+/, "") };
}

export function renderSkillList(skills: ShippedSkill[]): string {
  const width = Math.max(...skills.map((skill) => skill.name.length));
  return skills.map((skill) => `${skill.name.padEnd(width)}  ${skill.description}`).join("\n");
}

/** Looks up each name, or says which ones are unknown and what exists. */
export function findSkills(
  names: string[],
  skills: ShippedSkill[],
): { ok: true; found: ShippedSkill[] } | { ok: false; text: string } {
  const unknown = names.filter((name) => !skills.some((skill) => skill.name === name));
  if (unknown.length > 0) {
    const available = skills.map((skill) => skill.name).join(", ");
    return {
      ok: false,
      text: `No skill named ${unknown.join(", ")}. The skills are: ${available}.`,
    };
  }
  return { ok: true, found: names.map((name) => skills.find((skill) => skill.name === name)!) };
}

/**
 * What `install` writes: the frontmatter and a line telling the agent to
 * run `agency skills show`, or with `full`, the whole skill. See
 * docs/dev/cli/skills-command.md for why the stub is the default.
 *
 * The description is written as a JSON string, which is also a valid YAML
 * string, so a colon or quote in it cannot break another agent's parser.
 */
export function renderInstalledFile(skill: ShippedSkill, full: boolean): string {
  const frontmatter = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n`;
  const body = full
    ? skill.body
    : `Run \`agency skills show ${skill.name}\` and follow what it prints. ` +
      "It prints the instructions that match the agency you have installed. " +
      "If `agency` is not on your PATH, run it through the project's package manager, " +
      `such as \`npx agency skills show ${skill.name}\`.\n`;
  return `${frontmatter}\n${INSTALL_MARKER}\n\n${body}`;
}

/** Turns the target flags into one directory. Exactly one flag must be set. */
export function resolveInstallDir(
  flags: InstallTargetFlags,
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
): { ok: true; dir: string } | { ok: false; text: string } {
  const chosen = [flags.claude, flags.project, flags.dir !== undefined].filter(Boolean).length;
  if (chosen !== 1) {
    return {
      ok: false,
      text:
        "Say where to install with exactly one of: --claude (~/.claude/skills), " +
        "--project (.claude/skills in this directory), or --dir <path>.",
    };
  }
  if (flags.claude) {
    return { ok: true, dir: path.join(homeDir, ".claude", "skills") };
  }
  if (flags.project) {
    return { ok: true, dir: path.join(cwd, ".claude", "skills") };
  }
  return { ok: true, dir: path.resolve(cwd, flags.dir!) };
}

function skillPaths(dir: string, name: string): { skillDir: string; file: string } {
  const skillDir = path.join(dir, name);
  return { skillDir, file: path.join(skillDir, "SKILL.md") };
}

/**
 * Writes `<dir>/<name>/SKILL.md`. It refuses a symlink at the skill's
 * folder or file, and refuses to overwrite a file that does not carry
 * the install marker, since someone else wrote that one.
 */
export function installSkill(skill: ShippedSkill, dir: string, full: boolean): Outcome {
  const refusal = refuseTarget(dir, skill.name);
  if (refusal !== null) {
    return { ok: false, text: refusal };
  }
  const { skillDir, file } = skillPaths(dir, skill.name);
  fs.mkdirSync(skillDir, { recursive: true });
  // O_NOFOLLOW so a symlink planted after the check is refused, not followed.
  const flag =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(file, flag, 0o644);
  try {
    fs.writeFileSync(fd, renderInstalledFile(skill, full));
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true, text: `Installed ${skill.name} at ${file}` };
}

/** Why `install` must not write this skill into `dir`, or null if it may. */
function refuseTarget(dir: string, name: string): string | null {
  const { skillDir, file } = skillPaths(dir, name);
  const dirStat = lstatOrNull(skillDir);
  if (dirStat?.isSymbolicLink()) {
    return `${skillDir} is a symlink. Remove it, or install somewhere else.`;
  }
  if (dirStat && !dirStat.isDirectory()) {
    return `${skillDir} exists and is not a folder.`;
  }
  const fileStat = lstatOrNull(file);
  if (fileStat === null) {
    return null;
  }
  if (fileStat.isSymbolicLink()) {
    return `${file} is a symlink. Remove it, or install somewhere else.`;
  }
  if (!fileStat.isFile()) {
    return `${file} exists and is not a file.`;
  }
  if (!fs.readFileSync(file, "utf8").includes(INSTALL_MARKER_PREFIX)) {
    return `${file} already exists and was not written by agency skills install. Remove it first if you want to replace it.`;
  }
  return null;
}

/** The path's own stats, or null when nothing is there. Any other error,
 *  such as a permission error, is thrown. */
function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * `agency skills install`. It checks the target flags, every name, and
 * every skill's target before writing anything, and reports every refusal
 * at once, so a refusal never leaves some skills installed and others not.
 */
export function runInstall(
  names: string[],
  flags: InstallTargetFlags & { full?: boolean },
  skills: ShippedSkill[] = listSkills(),
): Outcome {
  const target = resolveInstallDir(flags);
  if (!target.ok) {
    return target;
  }
  const lookup = findSkills(names, skills);
  if (!lookup.ok) {
    return lookup;
  }
  const refusals = lookup.found
    .map((skill) => refuseTarget(target.dir, skill.name))
    .filter((refusal) => refusal !== null);
  if (refusals.length > 0) {
    return { ok: false, text: refusals.join("\n") };
  }
  const lines: string[] = [];
  for (const skill of lookup.found) {
    const outcome = installSkill(skill, target.dir, flags.full ?? false);
    lines.push(outcome.text);
    if (!outcome.ok) {
      return { ok: false, text: lines.join("\n") };
    }
  }
  return { ok: true, text: lines.join("\n") };
}
