import assert from "node:assert/strict";

// Conversation IDs are random. Check them before omitting them from fixtures
// that compare message contents, without changing the live thread store.
export function messagesFixture(store) {
  const snapshot = JSON.parse(JSON.stringify(store));
  const ids = [];
  for (const thread of Object.values(snapshot.threads)) {
    assert.equal(typeof thread.id, "string");
    assert.ok(thread.id.length > 0, "conversation ID must not be empty");
    assert.ok(!ids.includes(thread.id), "conversations must have distinct IDs");
    ids.push(thread.id);
    delete thread.id;
  }
  return snapshot;
}
