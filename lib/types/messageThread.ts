import { AgencyNode } from "@/types.js";

type ThreadType = "thread" | "subthread";

export type MessageThread = {
  type: "messageThread";
  threadType: ThreadType;
  body: AgencyNode[];
};
