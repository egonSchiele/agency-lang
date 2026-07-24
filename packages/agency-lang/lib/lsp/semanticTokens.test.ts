import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  getSemanticTokens,
  SEMANTIC_TOKENS_LEGEND,
  TOKEN_MODIFIERS,
  TOKEN_TYPES,
} from "./semanticTokens.js";
import { runDiagnostics } from "./diagnostics.js";
import { SymbolTable } from "../symbolTable.js";
import type { DocumentState } from "./documentState.js";

/**
 * Build state the way the server does. Going through `runDiagnostics`
 * rather than calling `parseAgency` here matters: the parser has two
 * modes and they disagree about offsets, so a harness that picks the
 * mode itself can silently drift from what the server does.
 */
function stateFor(source: string): DocumentState {
  const doc = TextDocument.create("file:///test.agency", "agency", 1, source);
  const result = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
  if (!result.program || !result.info) {
    throw new Error("test source failed to parse");
  }
  return {
    program: result.program,
    info: result.info,
    semanticIndex: result.semanticIndex,
    scopes: result.scopes,
    symbolTable: new SymbolTable(),
    version: 1,
    lintFindings: result.lintFindings,
    lintBatchEdits: result.lintBatchEdits,
    lintVersion: 1,
  };
}

type DecodedToken = {
  text: string;
  line: number;
  col: number;
  type: string;
  modifiers: string[];
};

/**
 * Decode the wire format and slice the SOURCE at each decoded position.
 *
 * The slicing is the point. A test that asserts line and column numbers
 * is reading the same `loc` the implementation read, so a systematic
 * position error agrees with itself and passes. Asserting on the text
 * actually covered by the token catches an off-by-one column, a length
 * taken from the node span instead of the name, and a botched delta.
 *
 * The delta arithmetic here is deliberately written out rather than
 * imported from the implementation — a decoder that shares the encoder's
 * bug agrees with it.
 */
function decodeTokens(data: number[], source: string): DecodedToken[] {
  const lines = source.split("\n");
  const tokens: DecodedToken[] = [];
  let line = 0;
  let col = 0;

  for (let i = 0; i < data.length; i += 5) {
    const [deltaLine, deltaCol, length, typeIndex, modifierBits] = data.slice(i, i + 5);
    line += deltaLine;
    if (deltaLine === 0 && i > 0) {
      col += deltaCol;
    } else {
      col = deltaCol;
    }
    tokens.push({
      text: (lines[line] ?? "").slice(col, col + length),
      line,
      col,
      type: TOKEN_TYPES[typeIndex],
      modifiers: TOKEN_MODIFIERS.filter((_, bit) => (modifierBits & (1 << bit)) !== 0),
    });
  }
  return tokens;
}

function tokensFor(source: string): DecodedToken[] {
  return decodeTokens(getSemanticTokens(stateFor(source)).data, source);
}

/** Just the identifier texts, in emitted order. */
function textsFor(source: string): string[] {
  return tokensFor(source).map((t) => t.text);
}

describe("semantic tokens legend", () => {
  it("is a wire contract — reordering re-colours every open editor", () => {
    expect(SEMANTIC_TOKENS_LEGEND.tokenTypes).toEqual(["function"]);
    expect(SEMANTIC_TOKENS_LEGEND.tokenModifiers).toEqual(["defaultLibrary"]);
  });
});

describe("getSemanticTokens", () => {
  it("colours a local bound to a function and used bare", () => {
    // The whole reason this feature exists: no grammar can know `f` is a
    // function, because that needs type inference.
    const tokens = tokensFor(
      `def helper(): number {\n  return 1\n}\n\nnode main() {\n  const f = helper\n  print(f)\n}`,
    );
    const bare = tokens.filter((t) => t.text === "f");
    expect(bare.length).toBe(1);
    expect(bare[0].type).toBe("function");
    expect(bare[0].line).toBe(6);
  });

  it("colours a local that shadows a top-level function of the same name", () => {
    // If resolution regressed to the name-keyed SemanticIndex, the local
    // and the top-level definition would be indistinguishable.
    const source = `def run(): number {\n  return 1\n}\n\ndef other(): number {\n  return 2\n}\n\nnode main() {\n  const run = other\n  print(run)\n}`;
    const tokens = tokensFor(source);
    const shadowed = tokens.filter((t) => t.text === "run" && t.line === 10);
    expect(shadowed.length).toBe(1);
    expect(shadowed[0].type).toBe("function");
  });

  it("colours a function referenced inside a string interpolation", () => {
    // Interpolated expressions are real AST nodes with real positions.
    const source = `def helper(): number {\n  return 1\n}\n\nnode main() {\n  print("value \${helper()} here")\n}`;
    const tokens = tokensFor(source);
    const interpolated = tokens.filter((t) => t.text === "helper" && t.line === 5);
    expect(interpolated.length).toBe(1);
    expect(interpolated[0].type).toBe("function");
  });

  it("does not colour a function name that only appears in string text", () => {
    // Paired on purpose. A file containing ONLY the string would pass
    // against an empty slot table, since string text is never an
    // identifier node — it would test the parser, not this code. With a
    // real call in the same file, the exact count is what fails if
    // anyone regresses to whole-word source matching.
    const source = `def helper(): number {\n  return 1\n}\n\nnode main() {\n  print("the helper function")\n  helper()\n}`;
    const helperTokens = tokensFor(source).filter((t) => t.text === "helper");
    expect(helperTokens.length).toBe(1);
    expect(helperTokens[0].line).toBe(6);
  });

  it("marks builtins with the defaultLibrary modifier", () => {
    // Asserts the decoded bit, not merely that a modifier exists — an
    // off-by-one bit position is invisible otherwise.
    const tokens = tokensFor(`node main() {\n  print("hi")\n}`);
    const print = tokens.find((t) => t.text === "print");
    expect(print).toBeDefined();
    expect(print!.modifiers).toEqual(["defaultLibrary"]);
  });

  it("marks language primitives as well as prelude functions", () => {
    // Two separate registries feed the modifier — `print` above comes
    // from the prelude, `llm` is a language primitive. Both must count.
    const tokens = tokensFor(`node main() {\n  let x: string = llm("hi")\n}`);
    const llm = tokens.find((t) => t.text === "llm");
    expect(llm).toBeDefined();
    expect(llm!.modifiers).toEqual(["defaultLibrary"]);
  });

  it("does not mark a user function that shadows a prelude name", () => {
    // `print` is a prelude name, but here it is the user's own function.
    const tokens = tokensFor(
      `def print(msg: string): string {\n  return msg\n}\n\nnode main() {\n  print("hi")\n}`,
    );
    const call = tokens.find((t) => t.text === "print" && t.line === 5);
    expect(call).toBeDefined();
    expect(call!.modifiers).toEqual([]);
  });

  it("leaves user functions without the defaultLibrary modifier", () => {
    const tokens = tokensFor(
      `def helper(): number {\n  return 1\n}\n\nnode main() {\n  helper()\n}`,
    );
    const helper = tokens.find((t) => t.text === "helper" && t.line === 5);
    expect(helper!.modifiers).toEqual([]);
  });
});

describe("getSemanticTokens delta encoding", () => {
  it("encodes two tokens on the same line", () => {
    // Same-line and cross-line deltas are different branches of the
    // encoder. A suite with one token per line passes either way.
    const tokens = tokensFor(
      `def outer(x: number): number {\n  return x\n}\n\ndef inner(): number {\n  return 1\n}\n\nnode main() {\n  outer(inner())\n}`,
    );
    const onCallLine = tokens.filter((t) => t.line === 9);
    expect(onCallLine.map((t) => t.text)).toEqual(["outer", "inner"]);
    expect(onCallLine[0].col).toBe(2);
    expect(onCallLine[1].col).toBe(8);
  });

  it("encodes tokens separated by blank lines", () => {
    const tokens = tokensFor(
      `def a1(): number {\n  return 1\n}\n\ndef b2(): number {\n  return 2\n}\n\nnode main() {\n  a1()\n\n\n  b2()\n}`,
    );
    const calls = tokens.filter((t) => t.text === "a1" || t.text === "b2");
    expect(calls.map((t) => [t.text, t.line])).toEqual([
      ["a1", 9],
      ["b2", 12],
    ]);
  });

  it("emits tokens in source order when the walk yields out of order", () => {
    // walkNodes yields an assignment's value BEFORE its target access
    // chain, so `handlers[pick()] = run` walks `run`, then `pick`.
    // Without the sort this produces negative deltas and the decoder
    // reads garbage.
    const source = `def pick(): number {\n  return 0\n}\n\ndef run(): number {\n  return 1\n}\n\nnode main() {\n  let handlers = [1, 2]\n  handlers[pick()] = run\n}`;
    const onLine = tokensFor(source).filter((t) => t.line === 10);
    expect(onLine.map((t) => t.text)).toEqual(["pick", "run"]);
    // Columns strictly increase — the property that the delta encoding
    // depends on and that an unsorted push violates.
    expect(onLine[0].col).toBeLessThan(onLine[1].col);
  });
});

describe("getSemanticTokens known gaps", () => {
  it("TRIPWIRE: cannot colour identifiers inside a valueAccess chain", () => {
    // The parser attaches no `loc` to a valueAccess base or to the calls
    // in its chain, so `helper(1).invoke()` has no position to emit.
    //
    // WHEN THIS TEST FAILS: the parser has started carrying loc on those
    // nodes. That is the good outcome — identifierSlots will pick them up
    // with no change (its guard is on loc, not on node kind). Delete this
    // test, and revisit whether the extension's TextMate grammar should
    // stop guessing at function-ness.
    //
    // Paired with a bare call so it cannot pass against a broken walk.
    const source = `def helper(x: number): number {\n  return x\n}\n\nnode main() {\n  helper(1)\n  helper(1).invoke()\n}`;
    const helperTokens = tokensFor(source).filter((t) => t.text === "helper");
    expect(helperTokens.length).toBe(1);
    expect(helperTokens[0].line).toBe(5);
  });

  it.skip("block-scope shadowing is not resolved", () => {
    // findContainingScope only matches scopes named by a top-level
    // function or graphNode definition, so a name shadowed inside an
    // `if` branch resolves against the enclosing function instead.
    // Unskip when findContainingScope learns about block scopes.
    const source = `def helper(): number {\n  return 1\n}\n\nnode main() {\n  if (true) {\n    const helper = 5\n    print(helper)\n  }\n}`;
    expect(textsFor(source)).not.toContain("helper");
  });
});
