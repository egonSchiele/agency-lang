import { agency } from "agency-lang/runtime";

// Pins cross-language thread sharing: TS-side `agency.thread.user`
// writes and agency-side `std::thread.systemMessage` writes hit the
// SAME active `MessageThread`. The agent.agency entry interleaves
// the two — if `agency.thread.*` targeted a separate store, the
// `readThread()` readback would either miss the agency-side
// "middle-from-agency" message or miss the JS-side ones.
export function writeFromJs(content) {
  agency.thread.user(content);
}

export function readThread() {
  return agency.thread.current().messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}
