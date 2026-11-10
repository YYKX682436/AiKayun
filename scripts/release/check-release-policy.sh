#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
[[ "$repo" == 'YYKX682436/AiKayun' ]] || fail 'Unexpected release repository.'
[[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ]] || fail 'Release requires a manual workflow_dispatch event.'
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || fail 'Release must run from main.'
[[ "${GITHUB_ACTOR:-}" == YYKX682436 && "${GITHUB_TRIGGERING_ACTOR:-}" == YYKX682436 ]] || \
  fail 'Only the designated maintainer may start or rerun a release.'
[[ "${GITHUB_WORKFLOW_REF:-}" == 'YYKX682436/AiKayun/.github/workflows/release.yml@refs/heads/main' ]] || \
  fail 'Release must use the reviewed release workflow on main.'
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || fail 'Release source commit is invalid.'

repository="$(gh api "/repos/${repo}")" || fail 'Could not read release repository settings.'
[[ "$(jq -r '.private' <<<"$repository")" == true &&
   "$(jq -r '.default_branch' <<<"$repository")" == main ]] || \
  fail 'Release repository must remain private with main as its default branch.'
current_main="$(gh api "/repos/${repo}/git/ref/heads/main" --jq .object.sha)" || \
  fail 'Could not read the current main commit.'
[[ "$current_main" == "$GITHUB_SHA" ]] || fail 'Main moved after the release workflow was dispatched.'

printf 'Manual release policy verified for %s at %s.\n' "$GITHUB_ACTOR" "$GITHUB_SHA"
