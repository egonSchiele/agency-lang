// The naive polyfill most bundler shims give you. Included to PROVE it breaks.
let current = undefined;

export class AsyncLocalStorage {
  getStore() {
    return current;
  }
  run(store, callback, ...args) {
    const prev = current;
    current = store;
    try {
      return callback(...args);
    } finally {
      current = prev;
    }
  }
}
