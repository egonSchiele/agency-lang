import type { Node, NonterminalNode, IterationNode } from "ohm-js";
import type {
  NumberLiteral,
  StringLiteral,
  MultiLineStringLiteral,
  BooleanLiteral,
  VariableNameLiteral,
  PromptSegment,
  TextSegment,
  InterpolationSegment,
  FunctionCall,
  ValueAccess,
  AccessChainElement,
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
  SplatExpression,
  AgencyNode,
} from "@/types.js";
import type { BinOpExpression, Operator } from "@/types/binop.js";

type ASTNode = AgencyNode | BinOpExpression | SplatExpression;

function unescapeString(raw: string): string {
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\$/g, "$");
}

export function createSemantics(semantics: any): void {
  semantics.addOperation("toAST", {
    Exp(e: NonterminalNode) {
      return e.toAST();
    },

    BinOp(e: NonterminalNode) {
      return e.toAST();
    },

    // Binary operations
    OrExp_or(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "||", left: left.toAST(), right: right.toAST() };
    },
    OrExp(e: NonterminalNode) { return e.toAST(); },

    AndExp_and(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "&&", left: left.toAST(), right: right.toAST() };
    },
    AndExp(e: NonterminalNode) { return e.toAST(); },

    CmpExp_eq(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "==", left: left.toAST(), right: right.toAST() };
    },
    CmpExp_neq(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "!=", left: left.toAST(), right: right.toAST() };
    },
    CmpExp_lte(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "<=", left: left.toAST(), right: right.toAST() };
    },
    CmpExp_gte(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: ">=", left: left.toAST(), right: right.toAST() };
    },
    CmpExp_lt(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "<", left: left.toAST(), right: right.toAST() };
    },
    CmpExp_gt(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: ">", left: left.toAST(), right: right.toAST() };
    },
    CmpExp(e: NonterminalNode) { return e.toAST(); },

    AddExp_add(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "+", left: left.toAST(), right: right.toAST() };
    },
    AddExp_sub(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "-", left: left.toAST(), right: right.toAST() };
    },
    AddExp(e: NonterminalNode) { return e.toAST(); },

    MulExp_mul(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "*", left: left.toAST(), right: right.toAST() };
    },
    MulExp_div(left: NonterminalNode, _op: Node, right: NonterminalNode): BinOpExpression {
      return { type: "binOpExpression", operator: "/", left: left.toAST(), right: right.toAST() };
    },
    MulExp(e: NonterminalNode) { return e.toAST(); },

    UnaryExp_neg(_minus: Node, expr: NonterminalNode): ASTNode {
      // Produce a BinOp: 0 - expr, or just negate the number
      const inner = expr.toAST();
      if (inner.type === "number") {
        return { type: "number", value: "-" + inner.value } as NumberLiteral;
      }
      return {
        type: "binOpExpression",
        operator: "-",
        left: { type: "number", value: "0" } as NumberLiteral,
        right: inner,
      } as BinOpExpression;
    },
    UnaryExp(e: NonterminalNode) { return e.toAST(); },

    PriExp_paren(_lp: Node, e: NonterminalNode, _rp: Node) {
      return e.toAST();
    },
    PriExp(e: NonterminalNode) { return e.toAST(); },

    // Function calls
    FunctionCall(
      name: NonterminalNode,
      _lp: Node,
      args: NonterminalNode,
      _rp: Node,
    ): FunctionCall {
      return {
        type: "functionCall",
        functionName: name.sourceString,
        arguments: args.asIteration().children.map((c: Node) => c.toAST()),
      };
    },

    // Value access chains
    ValueAccess_methodCall(
      base: NonterminalNode,
      _dot: Node,
      method: NonterminalNode,
      _lp: Node,
      args: NonterminalNode,
      _rp: Node,
    ): ValueAccess {
      const baseAST = base.toAST() as ValueAccess;
      const methodCall: FunctionCall = {
        type: "functionCall",
        functionName: method.sourceString,
        arguments: args.asIteration().children.map((c: Node) => c.toAST()),
      };
      return {
        type: "valueAccess",
        base: baseAST.base,
        chain: [...baseAST.chain, { kind: "methodCall", functionCall: methodCall }],
      };
    },

    ValueAccess_prop(base: NonterminalNode, _dot: Node, prop: NonterminalNode): ValueAccess {
      const baseAST = base.toAST() as ValueAccess;
      return {
        type: "valueAccess",
        base: baseAST.base,
        chain: [...baseAST.chain, { kind: "property", name: prop.sourceString }],
      };
    },

    ValueAccess_index(base: NonterminalNode, _lb: Node, idx: NonterminalNode, _rb: Node): ValueAccess {
      const baseAST = base.toAST() as ValueAccess;
      return {
        type: "valueAccess",
        base: baseAST.base,
        chain: [...baseAST.chain, { kind: "index", index: idx.toAST() }],
      };
    },

    ValueAccess_baseMethodCall(
      base: NonterminalNode,
      _dot: Node,
      method: NonterminalNode,
      _lp: Node,
      args: NonterminalNode,
      _rp: Node,
    ): ValueAccess {
      const methodCall: FunctionCall = {
        type: "functionCall",
        functionName: method.sourceString,
        arguments: args.asIteration().children.map((c: Node) => c.toAST()),
      };
      return {
        type: "valueAccess",
        base: base.toAST(),
        chain: [{ kind: "methodCall", functionCall: methodCall }],
      };
    },

    ValueAccess_baseProp(base: NonterminalNode, _dot: Node, prop: NonterminalNode): ValueAccess {
      return {
        type: "valueAccess",
        base: base.toAST(),
        chain: [{ kind: "property", name: prop.sourceString }],
      };
    },

    ValueAccess_baseIndex(base: NonterminalNode, _lb: Node, idx: NonterminalNode, _rb: Node): ValueAccess {
      return {
        type: "valueAccess",
        base: base.toAST(),
        chain: [{ kind: "index", index: idx.toAST() }],
      };
    },

    AccessBase_paren(_lp: Node, e: NonterminalNode, _rp: Node) {
      return e.toAST();
    },

    AccessBase_ident(name: NonterminalNode): VariableNameLiteral {
      return { type: "variableName", value: name.sourceString };
    },

    // Literals
    Literal_variable(name: NonterminalNode): VariableNameLiteral {
      return { type: "variableName", value: name.sourceString };
    },

    numberLiteral_float(neg: IterationNode, whole: IterationNode, _dot: Node, frac: IterationNode): NumberLiteral {
      const sign = neg.sourceString;
      return { type: "number", value: sign + whole.sourceString + "." + frac.sourceString };
    },

    numberLiteral_int(neg: IterationNode, digits: IterationNode): NumberLiteral {
      const sign = neg.sourceString;
      return { type: "number", value: sign + digits.sourceString };
    },

    booleanLiteral_true(_: Node): BooleanLiteral {
      return { type: "boolean", value: true };
    },

    booleanLiteral_false(_: Node): BooleanLiteral {
      return { type: "boolean", value: false };
    },

    // Strings
    stringLiteral_double(_oq: Node, segments: IterationNode, _cq: Node): StringLiteral {
      return { type: "string", segments: mergeTextSegments(segments.children.map((c: Node) => c.toAST_segment())) };
    },

    stringLiteral_single(_oq: Node, segments: IterationNode, _cq: Node): StringLiteral {
      return { type: "string", segments: mergeTextSegments(segments.children.map((c: Node) => c.toAST_segment())) };
    },

    multiLineString(_oq: Node, segments: IterationNode, _cq: Node): MultiLineStringLiteral {
      return { type: "multiLineString", segments: mergeTextSegments(segments.children.map((c: Node) => c.toAST_segment())) };
    },

    // Arrays
    ArrayLiteral(_lb: Node, items: NonterminalNode, _comma: NonterminalNode, _rb: Node): AgencyArray {
      return {
        type: "agencyArray",
        items: items.asIteration().children.map((c: Node) => c.toAST()),
      };
    },

    ArrayElement(e: NonterminalNode) {
      return e.toAST();
    },

    SplatExp(_dots: Node, e: NonterminalNode): SplatExpression {
      return { type: "splat", value: e.toAST() };
    },

    // Objects
    ObjectLiteral(_lb: Node, entries: NonterminalNode, _comma: NonterminalNode, _rb: Node): AgencyObject {
      return {
        type: "agencyObject",
        entries: entries.asIteration().children.map((c: Node) => c.toAST()),
      };
    },

    ObjectEntry_splat(splat: NonterminalNode) {
      return splat.toAST();
    },

    ObjectEntry_kv(key: NonterminalNode, _colon: Node, value: NonterminalNode): AgencyObjectKV {
      return {
        key: key.toAST_key(),
        value: value.toAST(),
      };
    },

    // Identifiers
    ident(_start: Node, _rest: IterationNode) {
      return { type: "variableName", value: this.sourceString } as VariableNameLiteral;
    },

    _iter(...children: Node[]) {
      return children.map((c) => c.toAST());
    },

    _terminal() {
      return this.sourceString;
    },
  });

  // Separate operation for string segments to avoid type conflicts
  semantics.addOperation("toAST_segment", {
    stringSegment(e: NonterminalNode) { return e.toAST_segment(); },
    stringSegment_text(chars: IterationNode): TextSegment {
      return { type: "text", value: unescapeString(chars.sourceString) };
    },

    singleStringSegment(e: NonterminalNode) { return e.toAST_segment(); },
    singleStringSegment_text(chars: IterationNode): TextSegment {
      return { type: "text", value: unescapeString(chars.sourceString) };
    },

    multiLineSegment(e: NonterminalNode) { return e.toAST_segment(); },
    multiLineSegment_text(chars: IterationNode): TextSegment {
      return { type: "text", value: chars.sourceString };
    },

    interpolation_access(_open: Node, access: NonterminalNode, _close: Node): InterpolationSegment {
      return { type: "interpolation", expression: access.toAST_interp() as any };
    },
    interpolation_ident(_open: Node, name: NonterminalNode, _close: Node): InterpolationSegment {
      return { type: "interpolation", expression: { type: "variableName", value: name.sourceString } };
    },

    _terminal() {
      return { type: "text", value: this.sourceString } as TextSegment;
    },
  });

  // Operation for interpolation expressions (variable names and dot-access chains)
  semantics.addOperation("toAST_interp", {
    interpAccess_chain(base: NonterminalNode, _dot: Node, prop: NonterminalNode): ValueAccess {
      const baseAST = base.toAST_interp();
      if (baseAST.type === "valueAccess") {
        return {
          type: "valueAccess",
          base: baseAST.base,
          chain: [...baseAST.chain, { kind: "property", name: prop.sourceString }],
        };
      }
      return {
        type: "valueAccess",
        base: baseAST,
        chain: [{ kind: "property", name: prop.sourceString }],
      };
    },
    interpAccess_base(left: NonterminalNode, _dot: Node, right: NonterminalNode): ValueAccess {
      return {
        type: "valueAccess",
        base: { type: "variableName", value: left.sourceString } as VariableNameLiteral,
        chain: [{ kind: "property", name: right.sourceString }],
      };
    },
    interpIdent(_start: Node, _rest: IterationNode): VariableNameLiteral {
      return { type: "variableName", value: this.sourceString };
    },
  });

  // Operation for object keys
  semantics.addOperation("toAST_key", {
    objectKey_quoted(_oq: Node, chars: IterationNode, _cq: Node): string {
      return unescapeString(chars.sourceString);
    },
    objectKey_bare(name: NonterminalNode): string {
      return name.sourceString;
    },
  });
}

function mergeTextSegments(segments: PromptSegment[]): PromptSegment[] {
  const result: PromptSegment[] = [];
  for (const seg of segments) {
    if (seg.type === "text" && result.length > 0 && result[result.length - 1].type === "text") {
      (result[result.length - 1] as TextSegment).value += seg.value;
    } else {
      result.push(seg);
    }
  }
  return result;
}
