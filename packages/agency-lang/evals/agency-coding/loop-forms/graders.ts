import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "loop-form-fits-the-job",
    weight: 0.8,
    standard: `
    Agency has four ways to go over a list. From most to least preferred:

    1. List comprehensions
    const orderNames = [o.name for o in orders]

    2. Inline blocks using the builtin \`map\` function
    const doubled = map(xs, \\x -> x * 2)

    3. Full blocks using the builtin \`map\` function
    const lines = map(orders) as o {
      const subtotal = reduce(o.items, 0, \\(acc, n) -> acc + n)
      return "\${o.customer}: \${subtotal * 1.1}"
    }

    4. Plain for loops
    for (o in orders) {
      if (!o.paid) {
        return o.customer
      }
    }

    In terms of idiomatic Agency, the loops should be used in this order of preference.
    A plain \`for\` or \`while\` loop should only be used when the loop must stop early.

    Make sure that:
    1. orderTotals is a list comprehension, or a stdlib call with an inline block.
    2. receipts uses a full block with \`as\`, or a comprehension over a helper function, not a for loop that pushes into an array.
    3. firstUnpaid uses a plain for loop with an early return, or the stdlib \`find\`, not a comprehension that builds the whole list first.

    All three of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `export type Order = { customer: string, items: number[], paid: boolean }

export def orderTotals(orders: Order[]): number[] {
  return [reduce(o.items, 0, \\(acc, n) -> acc + n) for o in orders]
}

export def receipts(orders: Order[]): string[] {
  return map(orders) as o {
    const subtotal = reduce(o.items, 0, \\(acc, n) -> acc + n)
    let status = "due"
    if (o.paid) {
      status = "paid"
    }
    return "\${o.customer}: \${subtotal * 1.1} (\${status})"
  }
}

export def firstUnpaid(orders: Order[]): string {
  for (o in orders) {
    if (!o.paid) {
      return o.customer
    }
  }
  return ""
}`,
  }),
];
