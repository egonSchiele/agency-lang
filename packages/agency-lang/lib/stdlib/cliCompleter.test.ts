import { describe, expect, it } from "vitest";
import { buildCompleter } from "./cliCompleter.js";

describe("buildCompleter", () => {
  const listDir = async (dir: string) =>
    dir === "." ? [{ name: "lib", type: "dir" as const, size: 0 }] : [];
  const complete = (line: string) =>
    new Promise<[string[], string]>((resolve, reject) => {
      buildCompleter([["/cost", "Cost"]], listDir)(line, (err, result) =>
        err ? reject(err) : resolve(result),
      );
    });

  it("completes a slash command from the palette", async () => {
    expect(await complete("/co")).toEqual([["/cost"], "/co"]);
  });

  it("completes a file mention and replaces only the mention", async () => {
    expect(await complete("read @li")).toEqual([["@lib/"], "@li"]);
  });

  it("suggests nothing for an ordinary line", async () => {
    expect(await complete("hello li")).toEqual([[], "hello li"]);
  });
});
