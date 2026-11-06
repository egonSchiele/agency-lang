// One row of a log, expanded the way `agency logs session show` expands it,
// for `std::statelog`'s `logRow`. It reads one row from one log: no review
// comments and no open viewer.
import { formatAddress, splitAddress } from "@/logsViewer/address.js";
import { expandRow } from "@/logsViewer/rowText.js";
import { capString } from "@/runtime/trimStatelogEvent.js";

import { openQueryLog, refusal, type QueryDeps, type QueryResult } from "./shared.js";

/** The smallest cap on a row's text. Below the truncation marker's length,
 *  `capString` cannot keep a cut text under the cap. */
export const MIN_ROW_CHARS = 100;

export type RowOptions = {
  /** `<trace id>/<row id>`, as outline and search print it. */
  address: string;
  log?: string;
  /** At most this many characters of text, the marker included; 0 for no
   *  cap. */
  maxChars: number;
  /** False leaves out the row's events and a hosted row's provider items,
   *  which for an LLM call hold its whole message history. Default true. */
  events?: boolean;
};

export async function logsRow(options: RowOptions, deps: QueryDeps): Promise<QueryResult> {
  const { maxChars } = options;
  if (maxChars !== 0 && !(Number.isInteger(maxChars) && maxChars >= MIN_ROW_CHARS)) {
    return refusal(`${deps.names.maxChars} is 0 for no cap, or at least ${MIN_ROW_CHARS}`);
  }
  const log = await openQueryLog(options.log, deps);
  if ("refused" in log) {
    return refusal(log.refused);
  }
  const address = splitAddress(
    options.address,
    log.traces.map((trace) => trace.traceId),
  );
  if (address === undefined) {
    return refusal(
      `"${options.address}" is not a row address: use <trace id>/<row id>, as logOutline and logSearch print it`,
    );
  }
  const trace = log.traces.find((candidate) => candidate.traceId === address.traceId)!;
  const expanded = expandRow(trace.root, address.rowId);
  if (expanded === undefined) {
    return refusal(`no row ${address.rowId} in trace ${address.traceId}`);
  }
  let truncated = false;
  const text = capString(expanded.text, maxChars, () => {
    truncated = true;
  });
  const withEvents = options.events ?? true;
  const providerItems = withEvents ? expanded.json.providerItems : undefined;
  return {
    text,
    json: {
      address: formatAddress(address.traceId, address.rowId),
      kind: expanded.kind,
      header: expanded.header,
      truncated,
      events: withEvents ? expanded.json.events : [],
      ...(providerItems === undefined ? {} : { providerItems }),
    },
    exitCode: 0,
  };
}
