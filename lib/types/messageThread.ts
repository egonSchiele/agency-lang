import { AgencyNode } from "@/types.js";

export type MessageThread = {
  type: "messageThread";
  subthread: boolean;
  nodeId?: string;
  parentNodeId?: string;
  body: AgencyNode[];
};
