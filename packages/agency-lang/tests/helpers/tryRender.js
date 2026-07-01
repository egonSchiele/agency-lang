// Test helper: run `render(node)` from std::ui/layout and catch any
// thrown Error. Returns the error message (string) on failure or
// `null` if rendering succeeded — agency-side tests can compare the
// message against an exact expected substring to lock down validation
// behaviour without needing try/catch in Agency.

import { render } from "agency-lang/stdlib-lib/layout.js";

export function tryRender(node) {
  try {
    render(node);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
