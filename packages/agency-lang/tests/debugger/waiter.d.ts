// Types for waiter.js, the helper behind awaits-helper.agency.
export function waitForTest(): Promise<void>;
export function untilWaiting(): Promise<void>;
export function releaseWaiter(): void;
