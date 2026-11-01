#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*)
    [[ -n "${LICENSE_CENTER_READ_TOKEN:-}" ]]
    printf '%s\n' "$LICENSE_CENTER_READ_TOKEN"
    ;;
  *) exit 1 ;;
esac
