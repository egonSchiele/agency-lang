import type { TsNode } from "./tsIR.js";
import { ts } from "./builders.js";

/**
 * Fluent wrapper for TsNode construction.
 * Reads left-to-right instead of inside-out.
 *
 * Usage: $(ts.id("foo")).prop("bar").call([arg]).await().done()
 */
export class TsChain {
  constructor(public readonly node: TsNode) {}

  /** Property access: .prop("foo") → ts.prop(this, "foo") */
  prop(name: string): TsChain {
    return new TsChain(ts.prop(this.node, name));
  }

  /** Computed index: .index(expr) → ts.index(this, expr) */
  index(expr: TsNode): TsChain {
    return new TsChain(ts.index(this.node, expr));
  }

  /** Function call: .call([arg1, arg2]) → ts.call(this, [arg1, arg2]) */
  call(args: TsNode[] = []): TsChain {
    return new TsChain(ts.call(this.node, args));
  }

  /** Await: .await() → ts.await(this) */
  await(): TsChain {
    return new TsChain(ts.await(this.node));
  }

  /** Assign: .assign(rhs) → ts.assign(this, rhs) */
  assign(rhs: TsNode): TsChain {
    return new TsChain(ts.assign(this.node, rhs));
  }

  /** Spread: .spread() → ts.spread(this) */
  spread(): TsChain {
    return new TsChain(ts.spread(this.node));
  }

  /** Unwrap to plain TsNode */
  done(): TsNode {
    return this.node;
  }
}

/** Wrap any TsNode in a fluent chain */
export function $(node: TsNode): TsChain {
  return new TsChain(node);
}

/** Shorthand: wrap an identifier */
$.id = (name: string): TsChain => new TsChain(ts.id(name));
