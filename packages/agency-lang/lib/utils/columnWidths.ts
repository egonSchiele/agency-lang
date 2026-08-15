// Column-width distribution shared by std::ui/table (lib/stdlib/layout/
// table.ts) and the TUI TableComponent (lib/tui/table.ts). It operates
// on pre-measured widths — plain numbers — so it depends on nothing;
// each caller measures cell content with its own width function. Moved
// verbatim from lib/stdlib/layout/table.ts so the TUI primitive never
// imports stdlib internals.

export type PlannedWidth =
  { kind: "cells"; value: number } | { kind: "percent"; value: number } | { kind: "full" };

// A single column's sizing inputs, gathered up front so the
// width-distribution logic can read them as data rather than re-deriving
// from the raw column specs mid-loop.
export type ColumnPlan = {
  index: number;
  parsed: PlannedWidth | null; // null = natural content width
  natural: number; // caller-measured content width
  minWidth: number; // explicit floor
};

// Compute the final width of every column.
//
// Allocation order:
//   1. Fixed-cell columns claim their declared value.
//   2. Unsized columns claim their natural content width.
//   3. Percent / "full" columns share whatever is left of `available`.
//      When their declared percentages sum to > 100, each gets its
//      proportional share of the remainder; otherwise each gets its
//      literal share and the slack stays at the right edge.
//   4. `minWidth` is applied as a floor.
export function resolveColumnWidths(
  plan: ColumnPlan[],
  available: number | undefined,
  errorContext: string = "columnWidths",
): number[] {
  assertPercentsHaveBasis(plan, available, errorContext);

  const fixed = plan.map(fixedWidthFor);
  const claimed = fixed.reduce<number>((sum, w) => sum + (w ?? 0), 0);
  const remain = Math.max(0, (available ?? Infinity) - claimed);
  const totalPct = sumPercentages(plan);

  return plan.map((col, i) => {
    const own = fixed[i] ?? percentWidthFor(col, remain, totalPct);
    return Math.max(own, col.minWidth);
  });
}

function assertPercentsHaveBasis(
  plan: ColumnPlan[],
  available: number | undefined,
  errorContext: string,
): void {
  if (available !== undefined) return;
  const percentCol = plan.find((col) => isPercentLike(col.parsed));
  if (percentCol === undefined) return;
  throw new Error(
    `${errorContext}: column[${percentCol.index}] uses a percentage width ` +
      `but the table has no resolved width to take a percentage of. ` +
      `Set width: on the table or one of its ancestors.`,
  );
}

// Width for a column whose own size doesn't depend on the leftover
// space: fixed cells (declared count) or unsized (natural content
// width). Returns null for percent/full columns, which are sized later.
function fixedWidthFor(col: ColumnPlan): number | null {
  if (col.parsed === null) return col.natural;
  if (col.parsed.kind === "cells") return col.parsed.value;
  return null;
}

function percentWidthFor(col: ColumnPlan, remaining: number, totalPct: number): number {
  const pct = pctValue(col.parsed);
  const share = totalPct > 100 ? pct / totalPct : pct / 100;
  return Math.floor(remaining * share);
}

function isPercentLike(w: PlannedWidth | null): boolean {
  return w?.kind === "percent" || w?.kind === "full";
}

function pctValue(w: PlannedWidth | null): number {
  if (w?.kind === "percent") return w.value;
  if (w?.kind === "full") return 100;
  return 0;
}

function sumPercentages(plan: ColumnPlan[]): number {
  return plan.reduce((sum, col) => sum + pctValue(col.parsed), 0);
}
