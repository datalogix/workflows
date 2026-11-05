# shellcheck shell=bash
# Laravel Forge: the site's deploy hook. Forge deploys the branch head; the commit variable makes the deploy script
# check out this exact commit (setup adds that check to the script)

# Seconds a deploy usually takes, waited before watching when settle-seconds is 0
provider_settle_seconds() {
  echo 120
}

provider_check() {
  require_deploy_hook
}

provider_trigger() {
  post_hook \
    --data-urlencode "forge_deploy_branch=$BRANCH" \
    --data-urlencode "forge_deploy_commit=$1" \
    --data-urlencode "commit=$1"
}
