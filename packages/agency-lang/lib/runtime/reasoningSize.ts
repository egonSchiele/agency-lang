import type * as smoltalk from "smoltalk";

/** How many characters of reasoning an assistant message carries in its
 *  reasoning record. smoltalk sends the record back to the model that made
 *  it, so it counts toward the size of the next request. Size estimates add
 *  it; summaries and transcripts leave it out. 0 for any other message. */
export function reasoningChars(message: smoltalk.Message): number {
  if (message.role !== "assistant") {
    return 0;
  }
  const record = (message as smoltalk.AssistantMessage).reasoning;
  if (record === undefined) {
    return 0;
  }
  const details = record.details === undefined ? "" : JSON.stringify(record.details);
  const items = record.responsesItems === undefined ? "" : JSON.stringify(record.responsesItems);
  return record.text.length + details.length + items.length;
}
