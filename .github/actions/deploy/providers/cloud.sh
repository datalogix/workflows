# shellcheck shell=bash
# Laravel Cloud: the environment's deploy hook, which deploys the commit it is given

# Cloud builds an image first
provider_settle_seconds() {
  echo 300
}

provider_check() {
  require_deploy_hook
}

provider_trigger() {
  post_hook --data-urlencode "commit_hash=$1"
}
