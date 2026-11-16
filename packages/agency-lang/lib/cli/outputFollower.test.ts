import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { safeDeleteDirectoryWithin } from "@/utils.js";
import { outputFollower, type Repeater } from "./outputFollower.js";

/** A repeater the test drives by hand, so no test waits on a clock. */
function handTimer(): { repeat: Repeater; tick: () => void; running: () => boolean } {
  let current: (() => void) | null = null;
  return {
    repeat: (tick) => {
      current = tick;
      return () => {
        current = null;
      };
    },
    tick: () => current?.(),
    running: () => current !== null,
  };
}

describe("outputFollower", () => {
  let dir: string;
  let file: string;
  let printed: string;
  const write = (text: string) => {
    printed += text;
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-follow-"));
    file = path.join(dir, "output.log");
    printed = "";
    fs.writeFileSync(file, "earlier line\n");
  });
  afterEach(() => {
    safeDeleteDirectoryWithin(os.tmpdir(), dir);
  });

  it("prints what the file holds, then what is added to it", () => {
    const timer = handTimer();
    const follower = outputFollower(file, write, timer.repeat);
    follower.start();
    expect(printed).toBe("earlier line\n");
    fs.appendFileSync(file, "later line\n");
    expect(printed).toBe("earlier line\n");
    timer.tick();
    expect(printed).toBe("earlier line\nlater line\n");
  });

  it("prints nothing while paused, and catches up on resume", () => {
    const timer = handTimer();
    const follower = outputFollower(file, write, timer.repeat);
    follower.start();
    follower.pause();
    expect(timer.running()).toBe(false);
    fs.appendFileSync(file, "during the prompt\n");
    timer.tick();
    expect(printed).toBe("earlier line\n");
    follower.resume();
    expect(printed).toBe("earlier line\nduring the prompt\n");
    expect(timer.running()).toBe(true);
  });

  it("prints the rest of the file on finish, and stops", () => {
    const timer = handTimer();
    const follower = outputFollower(file, write, timer.repeat);
    follower.start();
    fs.appendFileSync(file, "last words\n");
    follower.finish();
    expect(printed).toBe("earlier line\nlast words\n");
    expect(timer.running()).toBe(false);
  });

  it("starts no second timer on a repeated resume, and none after finish", () => {
    let started = 0;
    const counting: Repeater = () => {
      started++;
      return () => {};
    };
    const follower = outputFollower(file, write, counting);
    follower.start();
    follower.resume();
    expect(started).toBe(1);
    follower.finish();
    follower.resume();
    expect(started).toBe(1);
  });

  it("holds a character split across two reads until it is whole", () => {
    const timer = handTimer();
    const whole = Buffer.from("é");
    fs.writeFileSync(file, whole.subarray(0, 1));
    const follower = outputFollower(file, write, timer.repeat);
    follower.start();
    expect(printed).toBe("");
    fs.appendFileSync(file, whole.subarray(1));
    timer.tick();
    expect(printed).toBe("é");
  });

  it("refuses an output file that is a symbolic link", () => {
    const link = path.join(dir, "link.log");
    fs.symlinkSync(file, link);
    expect(() => outputFollower(link, write)).toThrow("symbolic link");
  });
});
