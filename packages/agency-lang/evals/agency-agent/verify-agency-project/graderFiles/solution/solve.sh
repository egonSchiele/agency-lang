#!/usr/bin/env bash
# AGENCY_CLI lets the discrimination test use the checkout's built CLI.
set -u
run_agency() {
  if [ -n "${AGENCY_CLI:-}" ]; then
    node "$AGENCY_CLI" "$@"
  else
    agency "$@"
  fi
}

run_agency compile src/coordinator.agency > build.log 2>&1
build_status=$?
test_status=null
if [ "$build_status" -eq 0 ]; then
  run_agency test tool-wiring.test.json --agency-only --json > test-report.json 2> test.log
  test_status=$?
fi
printf '{"buildExitCode":%s,"testExitCode":%s}\n' "$build_status" "$test_status" > verification.json
