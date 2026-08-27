import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "no-js-array-methods",
    standard: `
    Here are the three ways to transform a list in Agency:

    const pending = [o for o in orders if !o.shipped]

    const sorted = sortBy(pending) as o {
      return o.total
    }
    // sortBy with an inline block:
    const sortedInline = sortBy(pending, \o -> o.total)

    const total = reduce(orders, 0) as (sum, o) {
      return sum + o.total
    }

    The first is a list comprehension. The other two call a stdlib function and pass it a block with \`as\`. Agency has no lambdas, so JavaScript array methods that take a callback, such as \`orders.filter(...)\`, \`orders.map(...)\`, \`orders.reduce(...)\`, \`orders.sort(...)\`, \`orders.find(...)\`, and \`orders.forEach(...)\`, must never appear. An interrupt cannot be raised inside a callback, so they typecheck and then crash at run time. Methods that take no callback, such as \`push\`, \`includes\`, \`join\`, and \`slice\`, are fine.

    Make sure that no array method that takes a callback is called anywhere in the file, such as .map or .reduce.
    
    If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `export type Order = { customer: string, total: number, shipped: boolean }

export def unshippedTotals(orders: Order[]): string[] {
  const pending = sortBy([o for o in orders if !o.shipped]) as o {
    return o.total
  }
  return ["\${o.customer}: \${o.total}" for o in pending]
}

export def grandTotal(orders: Order[]): number {
  return reduce(orders, 0) as (sum, o) {
    return sum + o.total
  }
}`,
  }),
];
