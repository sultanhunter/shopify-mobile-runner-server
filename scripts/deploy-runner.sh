#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-main}"
PM2_PROCESS="${PM2_PROCESS:-shopify-runner}"

log() {
  printf "\n[deploy] %s\n" "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf "[deploy] Missing required command: %s\n" "$1" >&2
    exit 1
  fi
}

log "Checking required commands"
require_cmd git
require_cmd npm
require_cmd pm2

log "Using repo: ${ROOT_DIR}"
log "Using branch: ${BRANCH}"
log "Using PM2 process: ${PM2_PROCESS}"

cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf "[deploy] This directory is not a git repository: %s\n" "$ROOT_DIR" >&2
  exit 1
fi

log "Updating code from origin/${BRANCH}"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

log "Installing dependencies"
npm install

log "Building runner"
npm run build

log "Ensuring persistent directories"
if [ -w /var ] || [ "$EUID" -eq 0 ]; then
  mkdir -p /var/shopify-mobile/projects /var/shopify-mobile/dev-workspaces /var/shopify-mobile/logs
else
  sudo mkdir -p /var/shopify-mobile/projects /var/shopify-mobile/dev-workspaces /var/shopify-mobile/logs
  sudo chown -R "$USER":"$USER" /var/shopify-mobile
fi

log "Restarting PM2 process"
pm2 restart "$PM2_PROCESS"
pm2 save

log "Deployment complete"
pm2 status "$PM2_PROCESS" || true
