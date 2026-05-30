import { AgencyNode, Expression } from "@/types.js";
import { BaseNode } from "./base.js";

type ThreadType = "thread" | "subthread";

export type MessageThread = BaseNode & {
  type: "messageThread";
  threadType: ThreadType;
  body: AgencyNode[];
  /** Optional template-level label from `thread(label: "...") { }`. */
  label?: Expression | null;
  /** Optional eager-summarize flag from `thread(summarize: true) { }`. */
  summarize?: Expression | null;
  /** Optional `thread(continue: <id>) { }` — resume a prior thread. */
  continueExpr?: Expression | null;
  /** Optional `thread(session: "name") { }` — sugar over continue. */
  sessionExpr?: Expression | null;
  /** Optional `thread(hidden: true) { }` — exclude from `listThreads()`. */
  hidden?: Expression | null;
};
