// Hand-maintained pins for the actions used by `agency schedule add --backend github`.
//
// To bump a version, follow the procedure in `docs/dev/contributing/updating-pinned-actions.md`.
// The short version: `make refresh-action-pins` to look up SHAs, paste them
// here, also update the matching tags in the `refresh-action-pins` target in
// the Makefile, regenerate the snapshot YAMLs, and commit.

export type PinnedAction = { sha: string; tag: string };

export const PINNED_ACTIONS: Record<string, PinnedAction> = {
  "actions/checkout": {
    sha: "34e114876b0b11c390a56381ad16ebd13914f8d5",
    tag: "v4.3.1",
  },
  "egonSchiele/run-agency-action": {
    sha: "365228e05038132741c4bda2fafe53113452aced",
    tag: "v1.2.0",
  },
};
