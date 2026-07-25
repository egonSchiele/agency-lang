// Zone.js-backed AsyncLocalStorage shim.
// Implements ONLY the subset Agency uses: run() + getStore().
// In the browser, import "zone.js" instead of "zone.js/node".
import "zone.js/node";

export class AsyncLocalStorage {
  constructor() {
    this._key = Symbol("als");
  }

  getStore() {
    // Zone.get walks up parent zones, so nested run() frames compose.
    return Zone.current.get(this._key);
  }

  run(store, callback, ...args) {
    const zone = Zone.current.fork({
      name: "als",
      properties: { [this._key]: store },
    });
    return zone.run(callback, undefined, args);
  }

  // enterWith / exit / disable intentionally omitted — Agency never calls them.
}
