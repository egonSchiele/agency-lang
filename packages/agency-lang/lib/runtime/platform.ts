// The types the two "#platform" files share (platform.node.ts and
// platform.browser.ts).

/** The one field of StatelogClient provider loading needs. Structural so
 *  the runtime bootstrap can pass its client without this file importing
 *  the statelog module. */
export type LocalModelEventSink = {
  localModelLoaded(args: {
    model?: string;
    entryPath?: string;
    entrySource: string;
  }): Promise<void>;
};

/** What provider loading reads from the execution context. */
export type ProviderLoadingContext = {
  providerModules?: string[];
  smoltalkDefaults?: { provider?: string; model?: string };
  statelogClient?: LocalModelEventSink;
};
