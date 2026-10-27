#!/bin/sh
# scrub env inherited from a parent Claude Code session (ANTHROPIC_BASE_URL etc. break auth)
exec env $(env | grep -oE '^(CLAUDE[A-Z_]*|ANTHROPIC[A-Z_]*|AI_AGENT|BAGGAGE|__CFBundleIdentifier)=' | sed 's/=$//; s/^/-u /') "$(dirname "$0")/target/debug/acp-client-spike" "$@"
