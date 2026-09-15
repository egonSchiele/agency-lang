import { listenersBeforeKokoro } from "./listenersBefore.js";
import { removeListenersAddedSince } from "./processListeners.js";

// kokoro-js loads phonemizer, whose WebAssembly build adds process-wide
// uncaughtException and unhandledRejection listeners that rethrow. They
// crash a host program that handles those events itself.
removeListenersAddedSince(listenersBeforeKokoro);
