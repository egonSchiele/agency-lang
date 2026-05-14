// Hand-maintained. To bump versions:
//   1. Run `make refresh-action-pins` (which prints up-to-date SHAs).
//   2. Paste the new SHAs and tags here.
//   3. Commit. The diff should be small and reviewable.

export type PinnedAction = { sha: string; tag: string };

export const PINNED_ACTIONS: Record<string, PinnedAction> = {
  "actions/checkout": {
    sha: "b4ffde65f46336ab88eb53be808477a3936bae11",
    tag: "v4.1.7",
  },
  "egonSchiele/run-agency-action": {
    sha: "2a3030d846ce45a7c9d5eafad345e86db4f83a38",
    tag: "v1.0.2",
  },
};
