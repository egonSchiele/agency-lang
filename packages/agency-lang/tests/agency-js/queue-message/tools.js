import { agency } from "agency-lang/runtime";

export function queueNote(text) {
  agency.thread.current().queueMessage(text, { label: "note" });
  return "queued";
}

export function queueEarly(text) {
  agency.thread.current().queueMessage(text);
  return "queued";
}

export async function queueElsewhere(text) {
  await agency.thread.with("side-thread", () => {
    agency.thread.current().queueMessage(text);
  });
  return "queued elsewhere";
}
