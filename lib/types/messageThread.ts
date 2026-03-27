import { AgencyNode } from "@/types.js";
import { BaseNode } from "./base.js";

type ThreadType = "thread" | "subthread";

export type MessageThread = BaseNode & {
  type: "messageThread";
  threadType: ThreadType;
  body: AgencyNode[];
};
