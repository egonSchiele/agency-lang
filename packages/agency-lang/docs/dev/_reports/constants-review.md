# Constants centralization review

Automated weekly scan for 'magic' literals that belong in `lib/constants.ts`, run at 2026-11-16T09:18:06.978+00:00 UTC. The changes on this branch have ALREADY been applied; each item below explains one of them. CI runs on this branch — check it before merging.

Searching for repeated literals to centralize: AGENCY_IPC, AGENCY_IPC_DEBUG, AGENCY_AGENT_HOME, AGENCY_HOME, AGENCY_TRACE_ID, AGENCY_CHECKPOINT_KEY (already in checkpointChecksum.ts as constants inside file), AGENCY_OAUTH_TOKEN_DIR etc. I'll search for these.{"path":"packages/agency-lang/lib","pattern":"AGENCY_CONFIG_OVERRIDES","flags":"g","maxResults":200}
