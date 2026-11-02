#!/usr/bin/env bash
set -euo pipefail

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
token="${AIKAYUN_RELEASE_POLICY_READ_TOKEN:?A protected read-only repository policy token is required}"
api() { GH_TOKEN="$token" gh api "$@"; }

if ! branch_protection="$(api "/repos/${repo}/branches/main/protection")"; then
  echo 'The main branch must have a readable protected-branch policy before release.' >&2
  exit 1
fi
approvals="$(jq -r '.required_pull_request_reviews.required_approving_review_count // 0' <<<"$branch_protection")"
strict_checks="$(jq -r '.required_status_checks.strict // false' <<<"$branch_protection")"
required_checks="$(jq '[.required_status_checks.contexts[]?, .required_status_checks.checks[]?.context] | length' <<<"$branch_protection")"
admin_enforcement="$(jq -r '.enforce_admins.enabled // false' <<<"$branch_protection")"
[[ "$approvals" -ge 1 && "$strict_checks" == true && "$required_checks" -ge 1 && "$admin_enforcement" == true ]] || {
  echo 'The main branch must require a reviewer, a strict CI check, and administrator enforcement.' >&2
  exit 1
}

environment="$(api "/repos/${repo}/environments/aikayun-release")"
reviewers="$(jq '[.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]?] | length' <<<"$environment")"
protected_branch_policy="$(jq -r '.deployment_branch_policy.protected_branches // false' <<<"$environment")"
[[ "$reviewers" -ge 1 && "$protected_branch_policy" == true ]] || {
  echo 'The aikayun-release environment needs a reviewer gate and a protected-branch deployment policy.' >&2
  exit 1
}

rulesets="$(api "/repos/${repo}/rulesets?includes_parents=true&per_page=100")"
for id in $(jq -r '.[] | select(.target == "tag" and .enforcement == "active") | .id' <<<"$rulesets"); do
  details="$(api "/repos/${repo}/rulesets/${id}")"
  if jq -e '
      .target == "tag" and .enforcement == "active" and
      ([.conditions.ref_name.include[]?] | any(. == "refs/tags/v*" or . == "v*")) and
      ([.rules[].type] | index("update") != null and index("deletion") != null)
    ' >/dev/null <<<"$details"; then
    echo 'Protected main, release reviewer environment, and immutable v* tag rules verified.'
    exit 0
  fi
done
echo 'No active v* tag ruleset blocks tag updates and deletion.' >&2
exit 1
