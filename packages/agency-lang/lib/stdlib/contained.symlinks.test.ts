import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  root,
  readText,
  readBytes,
  readStream,
  writeText,
  writeBytes,
  list,
  stat,
  mkdir,
  remove,
  copy,
  move,
  PRIMITIVES,
  type Root,
} from "./contained.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

/**
 * The fixture every case builds:
 *
 *   base/
 *     outside/            a directory the approval never named
 *       secret.txt        "secret"
 *     real/               the approved directory
 *       inside.txt        "inside"
 *       sub/              a real, empty subdirectory
 *       file-out -> ../outside/secret.txt
 *       dir-out  -> ../outside
 *       dir-in   -> sub
 *       dangle   -> ../outside/missing
 *     linked -> real      the approved directory spelled through a link
 */
type Fixture = { base: string; real: string; outside: string; linked: string };

function build(prefix: string): Fixture {
  const base = fs.mkdtempSync(path.join(process.cwd(), `.battery-${prefix}-`));
  const outside = path.join(base, "outside");
  const real = path.join(base, "real");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(real, "sub"), { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.writeFileSync(path.join(real, "inside.txt"), "inside");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(real, "file-out"));
  fs.symlinkSync(outside, path.join(real, "dir-out"));
  fs.symlinkSync(path.join(real, "sub"), path.join(real, "dir-in"));
  fs.symlinkSync(path.join(outside, "missing"), path.join(real, "dangle"));
  const linked = path.join(base, "linked");
  fs.symlinkSync(real, linked);
  return { base, real, outside, linked };
}

function tearDown(fixture: Fixture): void {
  expect(safeDeleteDirectoryWithin(process.cwd(), fixture.base).success).toBe(true);
}

/** Proof that plain fs follows the link, so a refusal below means
 *  something. A dangling link is proven with lstat instead. */
function proveReachable(fixture: Fixture, target: string): void {
  const full = path.join(fixture.real, target);
  if (target.startsWith("dangle")) {
    expect(fs.lstatSync(full).isSymbolicLink()).toBe(true);
    return;
  }
  if (target.endsWith("x.txt")) {
    // A new name under a linked directory: the directory is reachable.
    expect(fs.existsSync(path.dirname(full))).toBe(true);
    return;
  }
  expect(fs.existsSync(full)).toBe(true);
}

function outsideUntouched(fixture: Fixture): void {
  expect(fs.readdirSync(fixture.outside)).toEqual(["secret.txt"]);
  expect(fs.readFileSync(path.join(fixture.outside, "secret.txt"), "utf8")).toBe("secret");
}

type Primitive = (typeof PRIMITIVES)[number];
type Run = (r: Root, target: string) => unknown;

/** One adapter per primitive. `target` is the entry under test; write
 *  adapters use a fixed payload. copy and move pair the target with a
 *  fresh name under the same root so the target is the only variable. */
const ADAPTERS: Record<Primitive, Run> = {
  readText: (r, t) => readText(r, t),
  readBytes: (r, t) => readBytes(r, t),
  readStream: (r, t) => {
    const stream = readStream(r, t);
    stream.destroy();
    return stream;
  },
  writeText: (r, t) => writeText(r, t, "payload"),
  writeBytes: (r, t) => writeBytes(r, t, Buffer.from("payload")),
  list: (r, t) => list(r, t),
  stat: (r, t) => stat(r, t),
  mkdir: (r, t) => mkdir(r, t),
  remove: (r, t) => remove(r, t),
  copy: (r, t) => copy({ root: r, target: t }, { root: r, target: "copy-dest" }),
  move: (r, t) => move({ root: r, target: t }, { root: r, target: "move-dest" }),
};

/** stat hides a refused entry as null rather than throwing. Everything
 *  else throws. */
function expectRefused(name: Primitive, run: () => unknown): void {
  if (name === "stat") {
    expect(run()).toBeNull();
    return;
  }
  expect(run).toThrow();
}

const LINK_TARGETS = [
  "file-out",
  "dir-out",
  "dir-out/secret.txt",
  "dir-in",
  "dir-in/x.txt",
  "dangle",
];

/** What the positive control does for each primitive, and what proves it
 *  behaved normally. */
function positiveTarget(name: Primitive): string {
  if (name === "mkdir") return "sub/new";
  if (name === "list") return "sub";
  return "inside.txt";
}

function checkPositive(name: Primitive, fixture: Fixture, result: unknown): void {
  const inside = path.join(fixture.real, "inside.txt");
  if (name === "readText") expect(result).toBe("inside");
  if (name === "readBytes") expect((result as Buffer).toString()).toBe("inside");
  if (name === "readStream") expect(result).toBeInstanceOf(fs.ReadStream);
  if (name === "writeText" || name === "writeBytes") {
    expect(fs.readFileSync(inside, "utf8")).toBe("payload");
  }
  if (name === "list") expect(result).toEqual([]);
  if (name === "stat") expect((result as fs.Stats).isFile()).toBe(true);
  if (name === "mkdir") {
    expect(fs.statSync(path.join(fixture.real, "sub", "new")).isDirectory()).toBe(true);
  }
  if (name === "remove") expect(fs.existsSync(inside)).toBe(false);
  if (name === "copy") expect(fs.existsSync(path.join(fixture.real, "copy-dest"))).toBe(true);
  if (name === "move") expect(fs.existsSync(path.join(fixture.real, "move-dest"))).toBe(true);
}

describe("the registry covers every adapter", () => {
  test("PRIMITIVES and ADAPTERS agree", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([...PRIMITIVES].sort());
  });
});

describe.each(PRIMITIVES)("%s", (name) => {
  const run = ADAPTERS[name];

  test.each(LINK_TARGETS)("refuses %s and leaves outside untouched", (target) => {
    const fixture = build(name);
    try {
      proveReachable(fixture, target);
      expectRefused(name, () => run(root(fixture.real), target));
      outsideUntouched(fixture);
      // Nothing appeared under the in-root link target either.
      expect(fs.readdirSync(path.join(fixture.real, "sub"))).toEqual([]);
    } finally {
      tearDown(fixture);
    }
  });

  test("positive control: the root spelled through a link behaves normally", () => {
    const fixture = build(name);
    try {
      const r = root(fixture.linked);
      expect(r.real).toBe(fs.realpathSync(fixture.real));
      const result = run(r, positiveTarget(name));
      checkPositive(name, fixture, result);
    } finally {
      tearDown(fixture);
    }
  });
});

describe("list hides links among real entries", () => {
  test("only real entries come back", () => {
    const fixture = build("list-mixed");
    try {
      const names = list(root(fixture.real), ".")
        .map((entry) => entry.name)
        .sort();
      expect(names).toEqual(["inside.txt", "sub"]);
    } finally {
      tearDown(fixture);
    }
  });
});

/** Replace `sub` with a link to `outside` while a descriptor under it is
 *  open. This is the swap a validated descriptor exists to catch. */
function swapSubForOutside(fixture: Fixture): void {
  fs.renameSync(path.join(fixture.real, "sub"), path.join(fixture.real, "sub.moved"));
  fs.symlinkSync(fixture.outside, path.join(fixture.real, "sub"));
}

describe("swap seams", () => {
  test("read: an ancestor replaced by a link between open and validation", () => {
    const fixture = build("read-swap");
    try {
      fs.writeFileSync(path.join(fixture.real, "sub", "a.txt"), "inside");
      fs.writeFileSync(path.join(fixture.outside, "a.txt"), "secret");
      expect(() =>
        readText(root(fixture.real), "sub/a.txt", {
          afterOpen: () => swapSubForOutside(fixture),
        }),
      ).toThrow(/outside/);
    } finally {
      tearDown(fixture);
    }
  });

  test("read: a swap undone after the open is caught by file identity", () => {
    const fixture = build("read-ident");
    try {
      const target = path.join(fixture.real, "inside.txt");
      expect(() =>
        readText(root(fixture.real), "inside.txt", {
          afterOpen: () => {
            fs.unlinkSync(target);
            fs.writeFileSync(target, "replacement");
          },
        }),
      ).toThrow(/changed between validation and read/);
    } finally {
      tearDown(fixture);
    }
  });

  test("append: an ancestor swapped to a link after the open writes nothing outside", () => {
    const fixture = build("append-swap");
    try {
      fs.writeFileSync(path.join(fixture.real, "sub", "a.txt"), "");
      expect(() =>
        writeText(root(fixture.real), "sub/a.txt", "payload", {
          mode: "append",
          seams: { afterOpen: () => swapSubForOutside(fixture) },
        }),
      ).toThrow(/outside/);
      outsideUntouched(fixture);
      expect(fs.readFileSync(path.join(fixture.real, "sub.moved", "a.txt"), "utf8")).toBe("");
    } finally {
      tearDown(fixture);
    }
  });

  test("overwrite: the temporary file is validated before any byte is written", () => {
    const fixture = build("over-swap");
    try {
      fs.writeFileSync(path.join(fixture.real, "sub", "a.txt"), "old");
      expect(() =>
        writeText(root(fixture.real), "sub/a.txt", "payload", {
          seams: { afterOpen: () => swapSubForOutside(fixture) },
        }),
      ).toThrow(/outside/);
      outsideUntouched(fixture);
      expect(fs.readFileSync(path.join(fixture.real, "sub.moved", "a.txt"), "utf8")).toBe("old");
    } finally {
      tearDown(fixture);
    }
  });
});

describe("a FIFO at the target", () => {
  test("read and append are refused without blocking", () => {
    const fixture = build("fifo");
    try {
      execFileSync("mkfifo", [path.join(fixture.real, "pipe")]);
      expect(() => readText(root(fixture.real), "pipe")).toThrow(/not a regular file/);
      // Opening a FIFO for writing with no reader fails with ENXIO before
      // fstat runs. Either way the write is refused and nothing blocks.
      expect(() => writeText(root(fixture.real), "pipe", "x", { mode: "append" })).toThrow(
        /not a regular file|ENXIO/,
      );
    } finally {
      tearDown(fixture);
    }
  });
});
