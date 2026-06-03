import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  Block,
  LayoutNode,
  above,
  beside,
  bordered,
  pad,
  render,
  renderNode,
  styled,
  _internal,
  _render,
} from "./layout.js";

function node(
  type: LayoutNode["type"],
  attrs: Record<string, unknown> = {},
  children: LayoutNode[] = [],
): LayoutNode {
  return { type, attrs, children };
}

const { visualWidth, sgr } = _internal;

describe("visualWidth", () => {
  test("plain string", () => {
    expect(visualWidth("hello")).toBe(5);
  });
  test("strips SGR sequences", () => {
    expect(visualWidth("\x1b[31mhi\x1b[0m")).toBe(2);
  });
  test("strips cursor moves", () => {
    expect(visualWidth("a\x1b[2Cb")).toBe(2);
  });
  test("empty string", () => {
    expect(visualWidth("")).toBe(0);
  });
});

describe("sgr", () => {
  test("empty style → empty string", () => {
    expect(sgr({})).toBe("");
  });
  test("bold", () => {
    expect(sgr({ bold: true })).toBe("\x1b[1m");
  });
  test("named color", () => {
    expect(sgr({ fgColor: "red" })).toBe("\x1b[38;2;205;49;49m");
  });
  test("hex color", () => {
    expect(sgr({ fgColor: "#cc7a4a" })).toBe("\x1b[38;2;204;122;74m");
  });
  test("multiple attributes combine", () => {
    // bold + fg=red
    expect(sgr({ bold: true, fgColor: "red" }))
      .toBe("\x1b[1;38;2;205;49;49m");
  });
});

describe("Block", () => {
  test("of single string splits on newline", () => {
    const b = Block.of("a\nb");
    expect(b.height).toBe(2);
    expect(b.width).toBe(1);
    expect(b.lines).toEqual(["a", "b"]);
  });
  test("of array preserves lines", () => {
    const b = Block.of(["hi", "there"]);
    expect(b.height).toBe(2);
    expect(b.width).toBe(5);
  });
  test("width ignores ANSI", () => {
    const b = Block.of("\x1b[31mhi\x1b[0m");
    expect(b.width).toBe(2);
  });
  test("empty block", () => {
    const b = Block.empty();
    expect(b.height).toBe(0);
    expect(b.width).toBe(0);
    expect(b.toString()).toBe("");
  });
  test("toString joins with newline", () => {
    expect(Block.of(["a", "b"]).toString()).toBe("a\nb");
  });
});

describe("pad", () => {
  test("widen, start align", () => {
    expect(pad(Block.of("hi"), 5, 1, "start").toString()).toBe("hi   ");
  });
  test("widen, center align", () => {
    expect(pad(Block.of("hi"), 5, 1, "center").toString()).toBe(" hi  ");
  });
  test("widen, end align", () => {
    expect(pad(Block.of("hi"), 5, 1, "end").toString()).toBe("   hi");
  });
  test("no-op when block already wider", () => {
    expect(pad(Block.of("hello"), 3, 1, "start").toString()).toBe("hello");
  });
  test("add rows below, vAlign=start", () => {
    expect(pad(Block.of("hi"), 2, 3, "start", "start").toString())
      .toBe("hi\n  \n  ");
  });
  test("add rows above, vAlign=end", () => {
    expect(pad(Block.of("hi"), 2, 3, "start", "end").toString())
      .toBe("  \n  \nhi");
  });
  test("center vertically", () => {
    expect(pad(Block.of("hi"), 2, 3, "start", "center").toString())
      .toBe("  \nhi\n  ");
  });
});

describe("styled", () => {
  test("empty style is identity", () => {
    expect(styled(Block.of("hi"), {}).toString()).toBe("hi");
  });
  test("wraps each line with bold + reset", () => {
    const b = styled(Block.of("a\nb"), { bold: true });
    expect(b.lines).toEqual(["\x1b[1ma\x1b[0m", "\x1b[1mb\x1b[0m"]);
  });
  test("visualWidth unchanged after styling", () => {
    const b = styled(Block.of("hello"), { bold: true, fgColor: "red" });
    expect(b.width).toBe(5);
  });
});

describe("beside", () => {
  test("simple side-by-side", () => {
    expect(beside(Block.of("a"), Block.of("b")).toString()).toBe("ab");
  });
  test("auto-pads shorter (right) to match height", () => {
    // left: 2 lines, right: 1 line → right gets a blank row appended
    expect(beside(Block.of(["a", "b"]), Block.of("c")).toString())
      .toBe("ac\nb ");
  });
  test("auto-pads shorter (left) to match height", () => {
    expect(beside(Block.of("a"), Block.of(["b", "c"])).toString())
      .toBe("ab\n c");
  });
  test("aligns widths within each block before concat", () => {
    // left "aa\nb": width=2, right "x": width=1
    expect(beside(Block.of(["aa", "b"]), Block.of("x")).toString())
      .toBe("aax\nb  ");
  });
  test("empty left → right", () => {
    expect(beside(Block.empty(), Block.of("hi")).toString()).toBe("hi");
  });
  test("empty right → left", () => {
    expect(beside(Block.of("hi"), Block.empty()).toString()).toBe("hi");
  });
});

describe("bordered (no title)", () => {
  test("rounded border around single line", () => {
    expect(bordered(Block.of("hi"), { borderStyle: "rounded" }).toString())
      .toBe(["╭──╮", "│hi│", "╰──╯"].join("\n"));
  });
  test("light border by default if unknown style resolved", () => {
    // explicit "light" (the default fallback)
    expect(bordered(Block.of("hi"), { borderStyle: "light" }).toString())
      .toBe(["┌──┐", "│hi│", "└──┘"].join("\n"));
  });
  test("heavy border", () => {
    expect(bordered(Block.of("a"), { borderStyle: "heavy" }).toString())
      .toBe(["┏━┓", "┃a┃", "┗━┛"].join("\n"));
  });
  test("double border", () => {
    expect(bordered(Block.of("a"), { borderStyle: "double" }).toString())
      .toBe(["╔═╗", "║a║", "╚═╝"].join("\n"));
  });
  test("padding adds space around content (center align)", () => {
    // padding 1 → content width 2 → inner 4, height 1 → inner 3
    const out = bordered(Block.of("hi"), {
      borderStyle: "rounded",
      padding: 1,
    }).toString();
    expect(out).toBe(
      [
        "╭────╮",
        "│    │",
        "│ hi │",
        "│    │",
        "╰────╯",
      ].join("\n"),
    );
  });
  test("borderColor wraps every border segment with SGR", () => {
    const out = bordered(Block.of("a"), {
      borderStyle: "light",
      borderColor: "red",
    }).toString();
    // border characters should be wrapped; content untouched
    expect(out).toMatch(/\x1b\[38;2;205;49;49m┌─┐\x1b\[0m/);
    expect(out).toContain("a"); // content present
    // verify visual width per row is consistent
    for (const line of out.split("\n")) {
      expect(_internal.visualWidth(line)).toBe(3);
    }
  });
  test("multi-line content", () => {
    expect(
      bordered(Block.of(["aa", "b"]), { borderStyle: "light" }).toString(),
    ).toBe(["┌──┐", "│aa│", "│b │", "└──┘"].join("\n"));
  });
  test("unknown borderStyle falls back to light + warns once", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => { warns.push(msg); };
    try {
      const out = bordered(Block.of("a"), { borderStyle: "round" as any }).toString();
      // Falls back to "light" — `┌─┐` corner row.
      expect(out.split("\n")[0]).toBe("┌─┐");
      // Subsequent calls with the same unknown style don't warn again
      // (per resolveBorderStyle's `warnedUnknownStyles` set).
      bordered(Block.of("a"), { borderStyle: "round" as any });
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatch(/unknown borderStyle/);
    } finally {
      console.warn = orig;
    }
  });
  test("__proto__ borderStyle does not crash and falls back", () => {
    // Without an own-property check, `"__proto__" in BORDER_CHARS` is true
    // → returns `Object.prototype` → renderer crashes on `ch.tl`. This
    // test pins the "must fall back" contract.
    const orig = console.warn;
    console.warn = () => {};
    try {
      expect(() =>
        bordered(Block.of("a"), { borderStyle: "__proto__" as any }),
      ).not.toThrow();
      const out = bordered(Block.of("a"), {
        borderStyle: "__proto__" as any,
      }).toString();
      // Output should use the light fallback, not produce garbage.
      expect(out.split("\n")[0]).toBe("┌─┐");
    } finally {
      console.warn = orig;
    }
  });
});

describe("bordered (with title)", () => {
  test("short title fits inside natural width", () => {
    // content width 20 → top "╭─ X ──...──╮"
    const out = bordered(Block.of("x".repeat(20)), {
      borderStyle: "rounded",
      title: "X",
    }).toString();
    const lines = out.split("\n");
    expect(lines[0]).toBe("╭─ X ────────────────╮");
    expect(_internal.visualWidth(lines[0])).toBe(22);
    expect(_internal.visualWidth(lines[1])).toBe(22);
  });
  test("long title forces box to grow (no truncation)", () => {
    const out = bordered(Block.of("hi"), {
      borderStyle: "rounded",
      title: "LongTitle",
    }).toString();
    const lines = out.split("\n");
    // top: ╭─ LongTitle ──╮, width must accommodate visualWidth("LongTitle") + 4 = 13
    // inner block "hi" has width 2; row+cols must be at least 13 → inner padded to 11
    expect(lines[0]).toBe("╭─ LongTitle ─╮");
    expect(_internal.visualWidth(lines[1])).toBe(_internal.visualWidth(lines[0]));
  });
  test("titleColor differs from borderColor", () => {
    const out = bordered(Block.of("hi"), {
      borderStyle: "light",
      borderColor: "red",
      title: "T",
      titleColor: "blue",
    }).toString();
    // red border wraps the corners and dashes, blue wraps the title " T "
    expect(out).toContain("\x1b[38;2;205;49;49m"); // red
    expect(out).toContain("\x1b[38;2;36;114;200m"); // blue
    // title's blue sgr should appear before "T"
    const top = out.split("\n")[0];
    expect(top).toMatch(/\x1b\[38;2;36;114;200m T \x1b\[0m/);
  });
  test("widths remain consistent after title growth", () => {
    const out = bordered(Block.of("hi"), {
      borderStyle: "rounded",
      title: "Hello World",
      padding: 1,
    }).toString();
    const widths = out.split("\n").map(_internal.visualWidth);
    const unique = new Set(widths);
    expect(unique.size).toBe(1);
  });
});

describe("leaf renderers", () => {
  test("text — plain", () => {
    expect(render(node("text", { content: "hi" }))).toBe("hi");
  });
  test("text — multi-line splits on \\n", () => {
    const b = renderNode(node("text", { content: "a\nb" }));
    expect(b.height).toBe(2);
  });
  test("text — applies bold + fgColor", () => {
    const out = render(node("text", { content: "hi", bold: true, fgColor: "red" }));
    expect(out).toBe("\x1b[1;38;2;205;49;49mhi\x1b[0m");
  });
  test("text — empty string still one row", () => {
    expect(renderNode(node("text", { content: "" })).height).toBe(1);
  });
  // align must reach the rendered Block so ragged multi-line text can
  // be centered/right-aligned within its own width. Uses content with
  // an even amount of extra space ("aaa" vs "b" → 2 extra) so the
  // center result is unambiguous; the convention in `padLine` for odd
  // extra is left-biased ("b " for width 2), matching the existing
  // `pad` test at the top of this file.
  test("text — align=center pads each line to block width", () => {
    expect(render(node("text", { content: "aaa\nb", align: "center" })))
      .toBe("aaa\n b ");
  });
  test("text — align=end right-aligns ragged lines", () => {
    expect(render(node("text", { content: "aa\nb", align: "end" })))
      .toBe("aa\n b");
  });
  test("text — align=start leaves ragged lines unpadded (height preserved)", () => {
    // start-align is the default; padding adds trailing spaces so all
    // lines have the same width. Tightens contract that even start
    // alignment normalises width.
    const b = renderNode(node("text", { content: "aa\nb", align: "start" }));
    expect(b.lines).toEqual(["aa", "b "]);
  });
  test("raw — align=center pads to block width", () => {
    expect(render(node("raw", { content: "aaa\nb", align: "center" })))
      .toBe("aaa\n b ");
  });
  test("raw — no styling applied", () => {
    // raw content with embedded SGR survives untouched.
    const styled = "\x1b[31mred\x1b[0m";
    expect(render(node("raw", { content: styled }))).toBe(styled);
  });
  test("raw — multi-line splits", () => {
    expect(renderNode(node("raw", { content: "a\nb" })).height).toBe(2);
  });
  test("hline with explicit length", () => {
    expect(render(node("hline", { char: "─", length: 4 }))).toBe("────");
  });
  test("hline applies fgColor", () => {
    const out = render(node("hline", { char: "─", length: 2, fgColor: "red" }));
    expect(out).toBe("\x1b[38;2;205;49;49m──\x1b[0m");
  });
  test("vline with explicit length", () => {
    expect(render(node("vline", { char: "│", length: 3 }))).toBe("│\n│\n│");
  });
  test("space — throws when rendered directly", () => {
    expect(() => render(node("space", { count: 3 }))).toThrow(/must be resolved/);
  });
  test("hline without length — throws", () => {
    expect(() => render(node("hline", { char: "─" }))).toThrow(/must be resolved/);
  });
  test("vline without length — throws", () => {
    expect(() => render(node("vline", { char: "│" }))).toThrow(/must be resolved/);
  });
});

describe("row renderer", () => {
  test("simple row of two text children", () => {
    const tree = node("row", {}, [
      node("text", { content: "a" }),
      node("text", { content: "b" }),
    ]);
    expect(render(tree)).toBe("ab");
  });
  test("row height grows to tallest child", () => {
    const tree = node("row", {}, [
      node("text", { content: "a\nb" }),
      node("text", { content: "c" }),
    ]);
    // c is start-aligned (default), so it sits on the top row
    expect(render(tree)).toBe("ac\nb ");
  });
  test("row align=center vertically centers shorter children", () => {
    const tree = node("row", { align: "center" }, [
      node("text", { content: "a\nb\nc" }),
      node("text", { content: "x" }),
    ]);
    expect(render(tree)).toBe("a \nbx\nc ");
  });
  test("gap inserts blank columns", () => {
    const tree = node("row", { gap: 2 }, [
      node("text", { content: "a" }),
      node("text", { content: "b" }),
    ]);
    expect(render(tree)).toBe("a  b");
  });
  test("empty container → empty block", () => {
    expect(render(node("row"))).toBe("");
  });
  test("align=end bottom-aligns shorter children", () => {
    const tree = node("row", { align: "end" }, [
      node("text", { content: "a\nb\nc" }),
      node("text", { content: "x" }),
    ]);
    expect(render(tree)).toBe("a \nb \ncx");
  });
});

describe("column renderer", () => {
  test("simple column of two text children", () => {
    const tree = node("column", {}, [
      node("text", { content: "a" }),
      node("text", { content: "b" }),
    ]);
    expect(render(tree)).toBe("a\nb");
  });
  test("column width grows to widest child", () => {
    const tree = node("column", {}, [
      node("text", { content: "ab" }),
      node("text", { content: "c" }),
    ]);
    // c is start-aligned (default) — gets trailing space
    expect(render(tree)).toBe("ab\nc ");
  });
  test("column align=center horizontally centers narrower children", () => {
    const tree = node("column", { align: "center" }, [
      node("text", { content: "abcd" }),
      node("text", { content: "x" }),
    ]);
    expect(render(tree)).toBe("abcd\n x  ");
  });
  test("gap inserts blank rows", () => {
    const tree = node("column", { gap: 1 }, [
      node("text", { content: "a" }),
      node("text", { content: "b" }),
    ]);
    expect(render(tree)).toBe("a\n \nb");
  });
  test("empty container → empty block", () => {
    expect(render(node("column"))).toBe("");
  });
  test("align=end right-aligns narrower children", () => {
    const tree = node("column", { align: "end" }, [
      node("text", { content: "abcd" }),
      node("text", { content: "x" }),
    ]);
    expect(render(tree)).toBe("abcd\n   x");
  });
});

describe("stretchy line + space resolution", () => {
  test("vline in row gets length from sibling height", () => {
    const tree = node("row", {}, [
      node("text", { content: "a\nb\nc" }),
      node("vline", { char: "│" }),
      node("text", { content: "x\ny\nz" }),
    ]);
    expect(render(tree)).toBe("a│x\nb│y\nc│z");
  });
  test("hline in column gets length from sibling width", () => {
    const tree = node("column", {}, [
      node("text", { content: "abc" }),
      node("hline", { char: "─" }),
      node("text", { content: "x" }),
    ]);
    expect(render(tree)).toBe("abc\n───\nx  ");
  });
  test("space in row adds visible gap", () => {
    const tree = node("row", {}, [
      node("text", { content: "a" }),
      node("space", { count: 3 }),
      node("text", { content: "b" }),
    ]);
    expect(render(tree)).toBe("a   b");
  });
  test("row(gap:1) + space(3) — additive", () => {
    const tree = node("row", { gap: 1 }, [
      node("text", { content: "a" }),
      node("space", { count: 3 }),
      node("text", { content: "b" }),
    ]);
    // gap inserts " " between each pair: a + " " + (space 3) + " " + b = "a   b" w/ a/b each gap-1 from neighbor
    // Actually: gap inserts gap-block between each consecutive pair:
    //   a, [gap " "], (space→"   "), [gap " "], b → "a    " + "  " + "b" wait. Let me think:
    // Sequence: ["a", "   ", "b"], with gap=1 between each pair → "a" + " " + "   " + " " + "b" = "a     b"
    expect(render(tree)).toBe("a     b");
  });
  test("space in column adds blank rows", () => {
    const tree = node("column", {}, [
      node("text", { content: "a" }),
      node("space", { count: 2 }),
      node("text", { content: "b" }),
    ]);
    expect(render(tree)).toBe("a\n \n \nb");
  });
  test("row of only a stretchy vline → length 1", () => {
    const tree = node("row", {}, [
      node("vline", { char: "│" }),
    ]);
    expect(render(tree)).toBe("│");
  });
  test("vline with explicit length is NOT clobbered by row's measured height", () => {
    // Sibling text is 3 lines tall, but the vline's explicit length 1
    // must win — resolveDynamicChildren only fills in bare lines.
    const tree = node("row", {}, [
      node("text", { content: "a\nb\nc" }),
      node("vline", { char: "│", length: 1 }),
    ]);
    // Row height is still 3 (driven by the text); the short vline gets
    // bottom-padded by row alignment (default "start" = top).
    expect(render(tree)).toBe("a│\nb \nc ");
  });
  test("hline in a row (wrong axis) still throws — not auto-stretched", () => {
    // hline only auto-stretches inside a column; in a row, an unsized
    // hline is a bug and must surface, not silently render as nothing.
    const tree = node("row", {}, [node("hline", { char: "─" })]);
    expect(() => render(tree)).toThrow(/must be resolved/);
  });
});

describe("box renderer", () => {
  test("single-child box, rounded default", () => {
    const tree = node("box", {}, [node("text", { content: "hi" })]);
    expect(render(tree)).toBe(["╭──╮", "│hi│", "╰──╯"].join("\n"));
  });
  test("multi-child box auto-wraps in column", () => {
    const tree = node("box", {}, [
      node("text", { content: "hello" }),
      node("text", { content: "x" }),
    ]);
    expect(render(tree)).toBe(
      ["╭─────╮", "│hello│", "│x    │", "╰─────╯"].join("\n"),
    );
  });
  test("box with title", () => {
    const tree = node("box", { title: "T" }, [
      node("text", { content: "hello world" }),
    ]);
    const out = render(tree);
    expect(out.split("\n")[0]).toBe("╭─ T ───────╮");
  });
  test("box with padding=1", () => {
    const tree = node("box", { padding: 1 }, [node("text", { content: "x" })]);
    expect(render(tree)).toBe(
      ["╭───╮", "│   │", "│ x │", "│   │", "╰───╯"].join("\n"),
    );
  });
  test("box with heavy border", () => {
    const tree = node("box", { borderStyle: "heavy" }, [
      node("text", { content: "a" }),
    ]);
    expect(render(tree)).toBe(["┏━┓", "┃a┃", "┗━┛"].join("\n"));
  });
  test("box with double border", () => {
    const tree = node("box", { borderStyle: "double" }, [
      node("text", { content: "a" }),
    ]);
    expect(render(tree)).toBe(["╔═╗", "║a║", "╚═╝"].join("\n"));
  });
  test("empty box renders a 1x1 frame (no children)", () => {
    // Empty children → composeBox falls back to Block.empty(); bordered
    // wraps it in a frame. Width 0 means `tl + tr` on the top edge.
    const out = render(node("box", {}, []));
    // The frame should at least not crash and produce a well-formed
    // rectangle. Widths must all match.
    const widths = out.split("\n").map(_internal.visualWidth);
    expect(new Set(widths).size).toBe(1);
    // And it must start with the rounded top-left corner.
    expect(out.startsWith("╭")).toBe(true);
  });
});

describe("above", () => {
  test("stacks vertically", () => {
    expect(above(Block.of("a"), Block.of("b")).toString()).toBe("a\nb");
  });
  test("pads narrower bottom with trailing spaces (start hAlign)", () => {
    expect(above(Block.of("aa"), Block.of("b")).toString()).toBe("aa\nb ");
  });
  test("pads narrower top with trailing spaces (start hAlign)", () => {
    expect(above(Block.of("a"), Block.of("bb")).toString()).toBe("a \nbb");
  });
  test("empty top → bottom", () => {
    expect(above(Block.empty(), Block.of("hi")).toString()).toBe("hi");
  });
});

describe('_render color: "auto"', () => {
  // Regression: "auto" mode used to depend solely on
  // `process.stdout.isTTY`, which is unreliable through nested
  // `spawn` chains. `_render` now also honours the de-facto
  // `NO_COLOR` / `FORCE_COLOR` env vars (set → override the TTY check).
  //
  // We save and restore the env across each test so the suite stays
  // hermetic — other tests shouldn't see leaked overrides.
  const savedNoColor    = process.env.NO_COLOR;
  const savedForceColor = process.env.FORCE_COLOR;
  const styled: LayoutNode = node("text", {
    content: "hi", fgColor: "red", bold: true,
  });

  beforeEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
  });
  afterEach(() => {
    if (savedNoColor    === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedForceColor;
  });

  test("NO_COLOR strips SGR even if TTY would have allowed it", () => {
    process.env.NO_COLOR = "1";
    expect(_render(styled, "auto")).not.toMatch(/\x1b\[/);
  });

  test("FORCE_COLOR=1 emits SGR even when stdout is not a TTY", () => {
    process.env.FORCE_COLOR = "1";
    expect(_render(styled, "auto")).toMatch(/\x1b\[/);
  });

  test("FORCE_COLOR=0 does NOT force enable (treated as falsy)", () => {
    process.env.FORCE_COLOR = "0";
    // Test runner stdout is not a TTY; "0" should not flip that.
    expect(_render(styled, "auto")).not.toMatch(/\x1b\[/);
  });

  test("FORCE_COLOR='false' does NOT force enable", () => {
    process.env.FORCE_COLOR = "false";
    expect(_render(styled, "auto")).not.toMatch(/\x1b\[/);
  });

  test("NO_COLOR wins over FORCE_COLOR (precedence)", () => {
    process.env.NO_COLOR    = "1";
    process.env.FORCE_COLOR = "1";
    expect(_render(styled, "auto")).not.toMatch(/\x1b\[/);
  });

  test('explicit color: true ignores env vars', () => {
    process.env.NO_COLOR = "1";
    expect(_render(styled, true)).toMatch(/\x1b\[/);
  });

  test('explicit color: false ignores env vars', () => {
    process.env.FORCE_COLOR = "1";
    expect(_render(styled, false)).not.toMatch(/\x1b\[/);
  });
});
