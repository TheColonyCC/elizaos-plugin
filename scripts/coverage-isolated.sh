#!/bin/sh
# Run vitest coverage in a transient systemd scope under user.slice so
# the v8 coverage instrumentation's memory usage doesn't share a cap
# with the Claude Code session that kicked the test off.
#
# Background: 2026-04-18 — a bun test:coverage run inside a Claude
# Code terminal hit ~8 GB, brushed the claude.slice MemoryHigh=8G soft
# cap, and systemd-oomd killed the whole scope (Claude + the vitest
# process). Running the test under a separate transient scope in
# user.slice means oomd still works if needed but the caps are
# independent — a runaway coverage run can't knock the chat session
# down.
#
# Falls back to plain `bun run test:coverage` when:
#   - systemd-run isn't available (macOS, non-systemd Linux)
#   - CI=true (GitHub Actions — runners don't need or expect slice
#     shenanigans, and systemd-run --user needs a running user
#     manager which the default runners don't have)
#
# Keep `test:coverage` as the canonical entry point for CI; this
# wrapper is a local-dev ergonomic only.

set -eu

if [ -n "${CI:-}" ] || ! command -v systemd-run >/dev/null 2>&1; then
  exec bun run test:coverage
fi

# Check the user manager is actually running — `systemd-run --user`
# fails with a clearer hint if it isn't.
if ! systemctl --user is-active --quiet default.target 2>/dev/null; then
  echo "coverage-isolated: systemd user manager not running — falling back to plain coverage"
  exec bun run test:coverage
fi

# --scope is synchronous (attaches to the terminal), --slice routes
# the transient scope under user.slice instead of inheriting the
# caller's slice, --quiet suppresses the "Running scope as unit…"
# boilerplate line.
exec systemd-run --user --scope --slice=user.slice --quiet bun run test:coverage
