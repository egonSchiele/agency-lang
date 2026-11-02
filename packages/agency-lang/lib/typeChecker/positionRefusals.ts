import type { AgencyNode } from "../types.js";
import type { HoistPosition, HoistStatus } from "../preprocessors/hoistPositions.js";
import { diagnostic, type DiagnosticName } from "./diagnostics.js";
import type { TypeCheckError } from "./types.js";

/** The diagnostic to report for each status the hoist pass cannot lift from. */
export type RefusalTable = {
  stuck: DiagnosticName;
  outsideBodies: DiagnosticName;
  handlerBody: DiagnosticName;
};

const REFUSED_STATUSES: (keyof RefusalTable)[] = ["stuck", "outsideBodies", "handlerBody"];

/**
 * One diagnostic per node that `isTarget` picks out and that sits where the
 * hoist pass cannot lift it. `table` names the diagnostic for each status and
 * `params` supplies that diagnostic's parameters. The checked cast and the `?`
 * operator both refuse the same three statuses, so the loop lives once here.
 */
export function positionRefusals<T extends AgencyNode>(
  positions: HoistPosition[],
  isTarget: (node: AgencyNode) => node is T,
  table: RefusalTable,
  params: (node: T) => Record<string, string>,
): TypeCheckError[] {
  return REFUSED_STATUSES.flatMap((status: HoistStatus & keyof RefusalTable) =>
    positions
      .filter((position) => position.status === status)
      .map((position) => position.node)
      .filter(isTarget)
      .map((node) => diagnostic(table[status], params(node) as any, node.loc ?? null)),
  );
}
