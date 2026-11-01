# How wide a `std::ui/table` is

A table with no `width` of its own is as wide as its content, up to a limit. When its cells are wider than the limit, its widest columns get narrower until it fits, and their text wraps.

## The limit

The limit is `ctx.availableWidth`, which `sizeTable` in `lib/stdlib/layout/table.ts` passes to `_resolveTableWidths` as `maxWidth`. At the root it is the terminal width (`resolveSizes` in `render.ts`). Inside a box or a row it is that container's inner width. With no terminal, the viewport is 80 columns (`DEFAULT_VIEWPORT`), so a program piped to a file gets tables wrapped at 80, as its plain text already is.

A table with its own `width` uses that width as the limit instead. Before this rule, `width: "full"` stretched the frame and left the columns at their content width, so the rows overflowed the frame.

The limit caps the table. It does not pad a small table out to the limit.

## Which columns shrink

`fitColumnWidths` in `lib/utils/columnWidths.ts` runs after `resolveColumnWidths`. Only columns with no width of their own shrink. Columns set to a fixed or percentage width keep what they asked for.

The shrinking columns all come down to one shared width, the largest that makes the table fit. A column already narrower than that keeps its width, so a table with one long column and one short one only loses width from the long one. For example, at 80 columns a `name | description` table with an 11-character key column and a 150-character description keeps the key column at 11 and wraps the description at 62. Cells left over after the shared width go to the leftmost shrunk columns.

No column goes below its `minWidth`, or below 1. When even every column at its floor is too wide, the table overflows.

A raw cell never wraps. A content-sized column holding one gets its natural width as its `minWidth` (`planColumns`), so it never shrinks and the row's right border stays in line.

A long title or caption still widens the table past the limit. This rule only covers the columns.

## Why `fitColumnWidths` is a separate function

The TUI table in `lib/tui/table.ts` also calls `resolveColumnWidths`, and its columns are meant to keep their content widths. Keeping the shrink step in its own function, called only by the stdlib table, leaves the TUI table's behavior unchanged.

## Diffs

`diff()` in `std::syntax` gives each changed line a colored background padded to the widest line in the diff, so the bars line up. `renderDiff` in `lib/utils/diff.ts` caps that padding at `maxWidth` minus the width of the line's gutter, which it measures from the gutter text itself (`gutterText`). `_diff` passes the terminal width as `maxWidth`. With no terminal there is no cap. A changed line longer than the bar still prints whole and wraps with its background.
