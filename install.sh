#!/usr/bin/env bash
# Break Free installer.
#
#   curl -fsSL https://raw.githubusercontent.com/maruthiprithivi/break-free/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --yes        # pass flags through
#   ./install.sh [--doctor|--uninstall|--yes|...]       # from inside a checkout
#
# Piped, it clones (or fast-forwards) $BREAK_FREE_HOME (default ~/.break-free) and runs
# the real installer, setup.mjs. From inside a checkout it just runs setup.mjs in place.
set -euo pipefail

REPO_URL="${BREAK_FREE_REPO:-https://github.com/maruthiprithivi/break-free.git}"
REPO_BRANCH="${BREAK_FREE_BRANCH:-main}"
HOME_DIR="${BREAK_FREE_HOME:-$HOME/.break-free}"
MIN_NODE=20

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
else
  B=''; R=''; Y=''; D=''; X=''
fi
say()  { printf '%s\n' "$*" >&2; }
step() { printf '%s==%s %s\n' "$B" "$X" "$*" >&2; }
die()  {
  printf '%sinstall failed:%s %s\n' "$R" "$X" "$1" >&2
  if [ $# -gt 1 ]; then printf '  %sfix:%s %s\n' "$Y" "$X" "$2" >&2; fi
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found" "$2"
}

check_node() {
  need node "install Node ${MIN_NODE}+ from https://nodejs.org, or: brew install node / nvm install ${MIN_NODE}"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$MIN_NODE" ] 2>/dev/null \
    || die "Node $(node -v 2>/dev/null) is too old — Break Free needs Node ${MIN_NODE}+" \
           "nvm install ${MIN_NODE} && nvm use ${MIN_NODE}   (or brew upgrade node)"
}

# Checked before anything is written to disk, so a too-old Node never leaves a stray checkout.
check_node

# Where is setup.mjs? Next to this script when run from a checkout; nowhere when piped.
here=""
case "${BASH_SOURCE[0]:-}" in
  ''|bash|/dev/*|/proc/*) ;;
  *) here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" ;;
esac

if [ -n "$here" ] && [ -f "$here/setup.mjs" ]; then
  root="$here"
else
  step "Break Free — fetching the source"
  need git "install git, or download the repo as a zip from ${REPO_URL%.git}"
  if [ -d "$HOME_DIR/.git" ]; then
    say "  updating $HOME_DIR"
    if ! { git -C "$HOME_DIR" fetch --quiet origin "$REPO_BRANCH" &&
           git -C "$HOME_DIR" checkout --quiet "$REPO_BRANCH" &&
           git -C "$HOME_DIR" merge --ff-only --quiet "origin/$REPO_BRANCH"; }; then
      die "could not fast-forward $HOME_DIR (local changes?)" \
          "cd $HOME_DIR && git status   — or move it aside and re-run"
    fi
  else
    if [ -e "$HOME_DIR" ]; then
      die "$HOME_DIR exists and is not a git checkout" \
          "move it aside, or set BREAK_FREE_HOME to another path"
    fi
    say "  cloning into $HOME_DIR"
    if ! git clone --quiet --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$HOME_DIR"; then
      die "git clone failed" "check your network, or clone it yourself: git clone $REPO_URL"
    fi
  fi
  root="$HOME_DIR"
  say "  ${D}source: $root${X}"
fi

cd "$root"

# setup.mjs is interactive. Under `curl | bash` stdin is the script itself, so give it the
# terminal back. /dev/tty can exist and still fail to open (a container with no controlling
# terminal), so try the open rather than trusting the device node.
if [ ! -t 0 ] && (exec </dev/tty) 2>/dev/null; then
  exec node setup.mjs "$@" </dev/tty
fi
exec node setup.mjs "$@"
