import { describe, it, expect } from "vitest";
import { paramDocs, stripBoundParams, withoutParamDocs } from "./paramDocs.js";

describe("stripBoundParams", () => {
  it("strips single @param line for bound param", () => {
    const description = `Read a file.
@param dir - The directory
@param filename - The file name`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Read a file.
@param filename - The file name`);
  });

  it("strips @param line without dash", () => {
    const description = `Do something.
@param dir The directory
@param filename The file`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Do something.
@param filename The file`);
  });

  it("strips multi-line @param entry until next @param", () => {
    const description = `Read a file.
@param dir - The directory to read from.
    Must be an absolute path.
@param filename - The file name`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Read a file.
@param filename - The file name`);
  });

  it("strips multi-line @param entry until blank line, preserving the blank line", () => {
    const description = `Read a file.

@param dir - The directory to read from.
    Must be absolute.

See also: writeFile`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Read a file.

See also: writeFile`);
  });

  it("passes through unchanged when no @param lines exist", () => {
    const description = "Read a file from a directory.";
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe("Read a file from a directory.");
  });

  it("strips multiple bound params", () => {
    const description = `Do math.
@param a - First number
@param b - Second number
@param c - Third number`;
    const result = stripBoundParams(description, ["a", "c"]);
    expect(result).toBe(`Do math.
@param b - Second number`);
  });

  it("handles indented @param lines", () => {
    const description = `Read a file.
  @param dir - The directory
  @param filename - The file`;
    const result = stripBoundParams(description, ["dir"]);
    expect(result).toBe(`Read a file.
  @param filename - The file`);
  });

  it("returns empty string for empty input", () => {
    expect(stripBoundParams("", ["dir"])).toBe("");
  });

  it("handles empty boundParamNames array (no-op)", () => {
    const description = `@param dir - The directory`;
    expect(stripBoundParams(description, [])).toBe(description);
  });
});

describe("paramDocs", () => {
  it("reads each entry's name and text, in order, with or without the dash", () => {
    const description = `Read a file.
@param dir - The directory
@param filename The file name`;
    expect(paramDocs(description)).toEqual([
      { name: "dir", text: "The directory" },
      { name: "filename", text: "The file name" },
    ]);
  });

  it("joins an entry's continuation lines with a space, up to a blank line", () => {
    const description = `Read a file.
  @param dir - The directory to read from.
      Must be an absolute path.

See also: writeFile`;
    expect(paramDocs(description)).toEqual([
      { name: "dir", text: "The directory to read from. Must be an absolute path." },
    ]);
  });

  it("gives an empty text to an entry with nothing after its name", () => {
    expect(paramDocs("@param flag")).toEqual([{ name: "flag", text: "" }]);
  });

  it("finds no entries in a description without @param lines", () => {
    expect(paramDocs("Read a file from a directory.")).toEqual([]);
  });
});

describe("withoutParamDocs", () => {
  it("removes every entry, whatever its name, with the blank line that ends it", () => {
    const description = `Read a file.

@param dir - The directory to read from.
@param fielname - A misspelled entry

See also: writeFile`;
    expect(withoutParamDocs(description)).toBe(`Read a file.

See also: writeFile`);
  });
});
