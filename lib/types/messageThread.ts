import { AgencyNode } from "@/types.js";

export type MessageThread = {
  type: "messageThread";
  subthread: boolean;
  threadId?: string;
  parentThreadId?: string;
  body: AgencyNode[];
};
