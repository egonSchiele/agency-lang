// The span properties a statelog keeps across a pause and resume. Each
// returned string is one broken property; an empty array means the log is
// sound. Used by the agency-js tests that pause and resume a run.
//
// - every parent_span_id names a span some event was logged in;
// - every toolCallStart has a toolCall in the same span;
// - no two toolCallStart events share a span.
export function spanProblems(events) {
  const problems = [];
  const spanIds = {};
  for (const event of events) {
    if (event.span_id) spanIds[event.span_id] = true;
  }
  for (const event of events) {
    if (event.parent_span_id && !spanIds[event.parent_span_id]) {
      problems.push(`${event.data.type} has a parent span that is not in the log`);
    }
  }
  const startsBySpan = {};
  const endsBySpan = {};
  for (const event of events) {
    if (event.data.type === "toolCallStart") {
      startsBySpan[event.span_id] = (startsBySpan[event.span_id] ?? 0) + 1;
    }
    if (event.data.type === "toolCall") {
      endsBySpan[event.span_id] = (endsBySpan[event.span_id] ?? 0) + 1;
    }
  }
  for (const [span, count] of Object.entries(startsBySpan)) {
    if (count > 1) problems.push(`${count} toolCallStart events share span ${span}`);
    if (!endsBySpan[span]) problems.push(`toolCallStart in span ${span} has no toolCall`);
  }
  return problems;
}
