// The rows the timeline draws: the kernel's spans, plus one bar per round
// for an llmCall that holds several. Round rows are a drawing decision, so
// they live outside spans.ts and take no part in self-time.
import { parseRoundId, type Round } from "./rounds.js";
import type { TimelineSpan } from "./spans.js";

export type SpanRow = { kind: "span"; id: string; depth: number; span: TimelineSpan };
export type RoundRow = { kind: "round"; id: string; depth: number; round: Round };
export type TimelineRow = SpanRow | RoundRow;

/** A span and the spans nested under it. */
type SpanBlock = { span: TimelineSpan; children: SpanBlock[] };

/** Something that takes a place in one level's time order. */
type Placed = { start: number; tieBreak: number; rows: TimelineRow[] };

type RoundsBySpan = Record<string, Round[]>;

const MIN_ROUNDS_FOR_ROWS = 2;
const ROUND_BEFORE_SPAN = 0;
const SPAN_AFTER_ROUND = 1;

/** With one round, its bar would repeat the span's own bar. */
export function drawsRoundRows(rounds: Round[]): boolean {
  return rounds.length >= MIN_ROUNDS_FOR_ROWS;
}

export function timelineRows(
  spans: TimelineSpan[],
  rounds: Round[],
  traceId?: string,
): TimelineRow[] {
  const bySpan = groupBySpan(rounds);
  // Rounds that are not inside any span belong to the trace itself, and
  // are laid out beside its top-level spans.
  const loose = traceId === undefined ? [] : (bySpan[traceId] ?? []);
  return rowsFor(nestByDepth(spans), loose, 0, bySpan);
}

export function rowIdFor(
  focusId: string,
  rows: TimelineRow[],
  rounds: Round[],
): string | undefined {
  const isDrawn = (id: string): boolean => rows.some((row) => row.id === id);
  if (isDrawn(focusId)) {
    return focusId;
  }
  const parsed = parseRoundId(focusId);
  const isKnownRound = rounds.some((round) => round.id === focusId);
  if (parsed === undefined || !isKnownRound || !isDrawn(parsed.spanId)) {
    return undefined;
  }
  return parsed.spanId;
}

/** Turn the kernel's flat depth-first list back into nested blocks. The
 *  heads of one level are the entries at that level's depth; each head owns
 *  everything up to the next head. Recursion follows depth, never the
 *  number of siblings. */
function nestByDepth(spans: TimelineSpan[]): SpanBlock[] {
  if (spans.length === 0) {
    return [];
  }
  const level = spans[0].depth;
  const heads = spans.flatMap((span, position) => (span.depth <= level ? [position] : []));
  return heads.map((from, headNumber) => {
    const to = heads[headNumber + 1] ?? spans.length;
    return { span: spans[from], children: nestByDepth(spans.slice(from + 1, to)) };
  });
}

/** Keep requested tools beneath their call, with other siblings in start order. */
function rowsFor(
  blocks: SpanBlock[],
  rounds: Round[],
  depth: number,
  roundsBySpan: RoundsBySpan,
): TimelineRow[] {
  const toolsByRound: Record<string, SpanBlock[]> = Object.create(null);
  const siblings: SpanBlock[] = [];
  for (const block of blocks) {
    const owner = requestingRound(block, rounds);
    if (owner === undefined) {
      siblings.push(block);
    } else {
      (toolsByRound[owner.id] ??= []).push(block);
    }
  }
  const placed: Placed[] = [
    ...rounds.map((round) => {
      const placed = placeRound(round, depth);
      placed.rows.push(...rowsFor(toolsByRound[round.id] ?? [], [], depth + 1, roundsBySpan));
      return placed;
    }),
    ...siblings.map((block) => placeBlock(block, depth, roundsBySpan)),
  ];
  const inOrder = [...placed].sort(
    (first, second) => first.start - second.start || first.tieBreak - second.tieBreak,
  );
  return inOrder.flatMap((entry) => entry.rows);
}

function placeRound(round: Round, depth: number): Placed {
  const row: RoundRow = { kind: "round", id: round.id, depth, round };
  return { start: round.start, tieBreak: ROUND_BEFORE_SPAN, rows: [row] };
}

/** Only direct tool children can belong to a call in this scope. */
function requestingRound(block: SpanBlock, rounds: Round[]): Round | undefined {
  if (block.span.kind !== "toolExecution") return undefined;
  const start = block.span.toolStartedAt ?? block.span.extent.start;
  return rounds
    .filter((round) => round.end <= start)
    .sort((first, second) => first.end - second.end)
    .at(-1);
}

function placeBlock(block: SpanBlock, depth: number, roundsBySpan: RoundsBySpan): Placed {
  const { span } = block;
  const own = roundsBySpan[span.id] ?? [];
  const hasRequestedTools = block.children.some(
    (child) => requestingRound(child, own) !== undefined,
  );
  const drawn = drawsRoundRows(own) || hasRequestedTools ? own : [];
  const spanRow: SpanRow = { kind: "span", id: span.id, depth, span };
  const below = rowsFor(block.children, drawn, depth + 1, roundsBySpan);
  return { start: span.extent.start, tieBreak: SPAN_AFTER_ROUND, rows: [spanRow, ...below] };
}

function groupBySpan(rounds: Round[]): RoundsBySpan {
  const spanIds = rounds.map((round) => round.spanId);
  const distinct = spanIds.filter((id, position) => spanIds.indexOf(id) === position);
  const entries = distinct.map((id) => [id, rounds.filter((round) => round.spanId === id)]);
  return Object.assign(Object.create(null), Object.fromEntries(entries));
}
