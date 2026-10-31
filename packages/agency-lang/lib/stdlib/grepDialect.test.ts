import { describe, it, expect } from "vitest";
import {
  _grepPatternToRegex,
  _renderGrepOutput,
  _skippedDirsNote,
  type GrepRender,
} from "./grepDialect.js";
import { SKIP_DIRS } from "./shell.js";

describe("_grepPatternToRegex: basic grep", () => {
  it("passes through letters, digits, and punctuation both read as plain text", () => {
    expect(_grepPatternToRegex("hello", "basic", false)).toBe("hello");
    expect(_grepPatternToRegex("key = value; # note", "basic", false)).toBe("key = value; # note");
  });

  it("passes through dot, star after a character, and the two anchors", () => {
    expect(_grepPatternToRegex("h.l*o", "basic", false)).toBe("h.l*o");
    expect(_grepPatternToRegex("^hello", "basic", false)).toBe("^hello");
    expect(_grepPatternToRegex("world$", "basic", false)).toBe("world$");
  });

  it("refuses characters that are plain text to basic grep but operators to JavaScript", () => {
    for (const pattern of ["a+b", "a?b", "a|b", "a(b)", "a{2}"]) {
      expect(_grepPatternToRegex(pattern, "basic", false)).toBeNull();
    }
  });

  it("refuses brackets, backslashes, and non-ASCII text, whose meanings differ between greps", () => {
    for (const pattern of ["[0-9]", "\\bword", "a\\|b", "héllo"]) {
      expect(_grepPatternToRegex(pattern, "basic", false)).toBeNull();
    }
  });

  it("refuses a star with nothing to repeat, and anchors away from the ends", () => {
    for (const pattern of ["*a", "a**", "^*a", "a$b", "a^b"]) {
      expect(_grepPatternToRegex(pattern, "basic", false)).toBeNull();
    }
  });
});

describe("_grepPatternToRegex: extended grep", () => {
  it("passes through the operators extended grep shares with JavaScript", () => {
    expect(_grepPatternToRegex("hello|goodbye", "extended", false)).toBe("hello|goodbye");
    expect(_grepPatternToRegex("colou?r", "extended", false)).toBe("colou?r");
    expect(_grepPatternToRegex("(ab)+", "extended", false)).toBe("(ab)+");
  });

  it("refuses unbalanced groups, a quantifier with nothing to repeat, and brackets", () => {
    for (const pattern of ["(ab", "ab)", "a|*b", "(*a)", "(?=a)", "[0-9]"]) {
      expect(_grepPatternToRegex(pattern, "extended", false)).toBeNull();
    }
  });
});

describe("_grepPatternToRegex: fixed strings", () => {
  it("escapes every character a JavaScript regex treats as an operator", () => {
    expect(_grepPatternToRegex("a+b", "fixed", false)).toBe("a\\+b");
    expect(_grepPatternToRegex("(x)", "fixed", false)).toBe("\\(x\\)");
    expect(_grepPatternToRegex("a.b", "fixed", false)).toBe("a\\.b");
  });

  it("refuses a newline, which grep reads as the start of a second pattern", () => {
    expect(_grepPatternToRegex("a\nb", "fixed", false)).toBeNull();
  });
});

describe("_grepPatternToRegex: control characters", () => {
  it("refuses a tab or a newline in every syntax", () => {
    for (const syntax of ["basic", "extended", "fixed"] as const) {
      expect(_grepPatternToRegex("a\tb", syntax, false)).toBeNull();
      expect(_grepPatternToRegex("a\nb", syntax, false)).toBeNull();
    }
  });
});

describe("_grepPatternToRegex: whole words", () => {
  it("translates a pattern made only of word characters", () => {
    expect(_grepPatternToRegex("hello", "basic", true)).toBe("hello");
    expect(_grepPatternToRegex("foo_1", "basic", true)).toBe("foo_1");
    expect(_grepPatternToRegex("foo_1", "fixed", true)).toBe("foo_1");
  });

  it("refuses an edge or inner character that is not a word character, where grep -w and \\b disagree", () => {
    for (const pattern of [" world", "h.llo", "a-b"]) {
      expect(_grepPatternToRegex(pattern, "basic", true)).toBeNull();
    }
  });

  it("with extended grep, accepts alternatives of word characters and nothing else", () => {
    expect(_grepPatternToRegex("foo|bar", "extended", true)).toBe("foo|bar");
    expect(_grepPatternToRegex("foo|b r", "extended", true)).toBeNull();
    expect(_grepPatternToRegex("foo|", "extended", true)).toBeNull();
  });
});

describe("_renderGrepOutput", () => {
  const matches = [
    { file: "a.txt", line: 1, text: "hello world" },
    { file: "sub/b.txt", line: 3, text: "hello again" },
  ];
  const directory: GrepRender = {
    lineNumbers: true,
    fileNames: "default",
    argument: "src",
    oneFile: false,
  };

  it("a directory search prints names joined to the path as written, then line numbers", () => {
    expect(_renderGrepOutput(matches, directory)).toBe(
      "src/a.txt:1:hello world\nsrc/sub/b.txt:3:hello again\n",
    );
  });

  it("a dot path prints names starting with ./, as grep does", () => {
    expect(_renderGrepOutput(matches, { ...directory, argument: "." })).toBe(
      "./a.txt:1:hello world\n./sub/b.txt:3:hello again\n",
    );
  });

  it("no path prints bare relative names", () => {
    expect(_renderGrepOutput(matches, { ...directory, argument: "" })).toBe(
      "a.txt:1:hello world\nsub/b.txt:3:hello again\n",
    );
  });

  it("a trailing slash on the path is not doubled, and the root stays the root", () => {
    expect(_renderGrepOutput(matches, { ...directory, argument: "src/" })).toBe(
      "src/a.txt:1:hello world\nsrc/sub/b.txt:3:hello again\n",
    );
    expect(_renderGrepOutput(matches, { ...directory, argument: "/" })).toBe(
      "/a.txt:1:hello world\n/sub/b.txt:3:hello again\n",
    );
  });

  it("without -n there are no line numbers, and -h drops the names", () => {
    expect(_renderGrepOutput(matches, { ...directory, lineNumbers: false })).toBe(
      "src/a.txt:hello world\nsrc/sub/b.txt:hello again\n",
    );
    expect(_renderGrepOutput(matches, { ...directory, fileNames: "never" })).toBe(
      "1:hello world\n3:hello again\n",
    );
  });

  it("one file prints no name unless -H asks, and then names it as written", () => {
    const oneFile: GrepRender = {
      lineNumbers: true,
      fileNames: "default",
      argument: "notes/a.txt",
      oneFile: true,
    };
    const single = [{ file: "a.txt", line: 1, text: "hello world" }];
    expect(_renderGrepOutput(single, oneFile)).toBe("1:hello world\n");
    expect(_renderGrepOutput(single, { ...oneFile, fileNames: "always" })).toBe(
      "notes/a.txt:1:hello world\n",
    );
  });

  it("a files-only search prints the names alone", () => {
    expect(_renderGrepOutput(["a.txt", "sub/b.txt"], directory)).toBe("src/a.txt\nsrc/sub/b.txt\n");
    const oneFile: GrepRender = { ...directory, argument: "notes/a.txt", oneFile: true };
    expect(_renderGrepOutput(["a.txt"], oneFile)).toBe("notes/a.txt\n");
  });

  it("no matches print nothing", () => {
    expect(_renderGrepOutput([], directory)).toBe("");
  });
});

describe("_skippedDirsNote", () => {
  it("names every folder the walk skips", () => {
    const note = _skippedDirsNote();
    for (const name of SKIP_DIRS) {
      expect(note).toContain(name);
    }
  });
});
