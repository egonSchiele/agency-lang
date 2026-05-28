import { agency } from "agency-lang/runtime";

// Pins that TS helpers writing via agency.thread.{system,user,assistant}
// hit the same ThreadStore the surrounding node body sees. The
// `writeMessages` function pushes three messages; `readThread` reads
// them back through the same accessor (`agency.thread.current()`).
// If the writes targeted a separate thread, `readThread` would
// return an empty array.
export async function writeMessages() {
  agency.thread.system("you are a tester");
  agency.thread.user("hi");
  agency.thread.assistant("hello");
}

export async function readThread() {
  return agency.thread.current().messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}
