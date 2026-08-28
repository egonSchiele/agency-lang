// Hand-maintained pins for the actions used by `agency schedule add --backend github`.
//
// To bump a version, follow the procedure in `docs/dev/contributing/updating-pinned-actions.md`.
// The short version: `make refresh-action-pins` to look up SHAs, paste them
// here, also update the matching tags in the `refresh-action-pins` target in
// the Makefile, regenerate the snapshot YAMLs, and commit.

export type PinnedAction = { sha: string; tag: string };

export const PINNED_ACTIONS: Record<string, PinnedAction> = {
  "actions/checkout": {
    sha: "b4ffde65f46336ab88eb53be808477a3936bae11",
    tag: "v4.1.7",
  },
  "egonSchiele/run-agency-action": {
    sha: "bdae9e6bd4ac9cddbbebcef877c7d35ffe3cfa8c",
    tag: "v1.1.0",
  },
};
