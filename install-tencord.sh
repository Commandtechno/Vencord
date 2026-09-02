#!/usr/bin/env bash
#
# install-tencord.sh
#
# Clones Commandtechno/Vencord (Tencord), builds the Vesktop targets, and wires
# the resulting dist/ directory into Vesktop's state.json so it loads on next
# launch instead of the default downloaded Vencord.
#
# Usage:
#   ./install-tencord.sh
#
#   Override the clone location:
#   CLONE_DIR=/path/to/Tencord ./install-tencord.sh
#
# Requirements: git, pnpm, jq
# Platforms:    Linux, macOS, Windows (Git Bash / MSYS2)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Repo to clone.
REPO="https://github.com/Commandtechno/Vencord"

# Where to clone the repo. Defaults to a "Tencord" folder sitting next to
# this script, which keeps everything self-contained inside the Vesktop dir.
CLONE_DIR="${CLONE_DIR:-$(cd "$(dirname "$0")" && pwd)/Tencord}"

# ---------------------------------------------------------------------------
# Tiny helpers
# ---------------------------------------------------------------------------

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merr\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

info "Checking required tools"

for tool in git pnpm jq; do
    command -v "$tool" > /dev/null 2>&1 || die "'$tool' is not installed or not on PATH"
done

ok "git, pnpm, jq all found"

# ---------------------------------------------------------------------------
# Locate Vesktop's state.json
#
# Vesktop stores runtime state (including the custom vencordDir we want to
# set) in state.json inside Electron's userData directory. The path differs
# by OS:
#
#   Linux   → ~/.config/vesktop/state.json
#   macOS   → ~/Library/Application Support/vesktop/state.json
#   Windows → %APPDATA%\vesktop\state.json
#             (Git Bash exposes %APPDATA% as $APPDATA)
#
# Source: src/main/constants.ts → DATA_DIR = app.getPath("userData")
#         src/main/settings.ts  → STATE_FILE = join(DATA_DIR, "state.json")
# ---------------------------------------------------------------------------

info "Detecting platform"

case "$(uname -s)" in
    Linux*)
        STATE_JSON="$HOME/.config/vesktop/state.json"
        ;;
    Darwin*)
        STATE_JSON="$HOME/Library/Application Support/vesktop/state.json"
        ;;
    MINGW* | MSYS* | CYGWIN*)
        # Git Bash / MSYS2 / Cygwin on Windows.
        # $APPDATA is already set by Windows to the Roaming folder, e.g.
        # C:\Users\<user>\AppData\Roaming — forward slashes work here.
        [[ -z "${APPDATA:-}" ]] && die "\$APPDATA is not set; run this script from Git Bash"
        STATE_JSON="${APPDATA}/vesktop/state.json"
        ;;
    *)
        die "Unsupported OS: $(uname -s)"
        ;;
esac

ok "state.json: $STATE_JSON"

[[ -f "$STATE_JSON" ]] || die "state.json not found — launch Vesktop at least once first"

# ---------------------------------------------------------------------------
# Clone or pull the Tencord repo
#
# If the directory already contains a git repo we fast-forward it so repeated
# runs stay up to date. If not, we wipe any leftover files and clone fresh.
# ---------------------------------------------------------------------------

if [[ -d "$CLONE_DIR/.git" ]]; then
    info "Repo already exists — updating"

    # Ensure origin points at the right URL. The script may have been edited
    # after the initial clone, or the directory may be a leftover from a
    # different fork. Fix it in place rather than re-cloning.
    current_remote="$(git -C "$CLONE_DIR" remote get-url origin 2>/dev/null || true)"
    if [[ "$current_remote" != "$REPO" ]]; then
        info "Remote mismatch ($current_remote) — updating to $REPO"
        git -C "$CLONE_DIR" remote set-url origin "$REPO"
    fi

    git -C "$CLONE_DIR" fetch origin
    # Reset to remote HEAD so local modifications don't block the update.
    git -C "$CLONE_DIR" reset --hard origin/HEAD
    ok "Updated to $(git -C "$CLONE_DIR" rev-parse --short HEAD)"
else
    info "Cloning $REPO → $CLONE_DIR"
    # Remove a stale non-git directory so clone doesn't complain.
    [[ -d "$CLONE_DIR" ]] && rm -rf "$CLONE_DIR"
    git clone "$REPO" "$CLONE_DIR" --depth 1
    ok "Cloned at $(git -C "$CLONE_DIR" rev-parse --short HEAD)"
fi

# ---------------------------------------------------------------------------
# Install Node dependencies
# ---------------------------------------------------------------------------

info "Installing dependencies"
(cd "$CLONE_DIR" && pnpm install)
ok "Dependencies installed"

# ---------------------------------------------------------------------------
# Build the Vesktop targets
#
# pnpm build (scripts/build/build.mjs) compiles six bundles in one pass:
#
#   For Discord Desktop (regular app injection):
#     dist/patcher.js
#     dist/preload.js
#     dist/renderer.js
#
#   For Vesktop (what we need):
#     dist/vencordDesktopMain.js     — runs in Electron's main process
#     dist/vencordDesktopPreload.js  — runs in the renderer's preload context
#     dist/vencordDesktopRenderer.js — injected into the Discord web page
#     dist/vencordDesktopRenderer.css — CSS side-output emitted by esbuild
#
# DO NOT run pnpm buildStandalone here — that adds the --standalone flag which
# skips the vencordDesktop* outputs (they are only built for non-standalone).
# ---------------------------------------------------------------------------

info "Building Tencord (Vesktop targets)"
(cd "$CLONE_DIR" && pnpm build)
ok "Build finished"

DIST_DIR="$CLONE_DIR/dist"

# Verify that all four files Vesktop requires actually exist.
# Vesktop's ensureVencordFiles() checks these exact names and will
# re-download stock Vencord if any of them are missing.
info "Verifying build output"
required_files=(
    vencordDesktopMain.js
    vencordDesktopPreload.js
    vencordDesktopRenderer.js
    vencordDesktopRenderer.css
)
for f in "${required_files[@]}"; do
    [[ -f "$DIST_DIR/$f" ]] || die "Expected build output not found: $DIST_DIR/$f"
done
ok "All required files present"

# Vesktop 1.6.x validates the custom dir by checking for package.json in
# addition to the four JS/CSS files above (see isValidVencordInstall in the
# compiled asar). The build does not produce this file. Without it, Vesktop
# treats the install as invalid and re-downloads official Vencord on launch,
# silently overwriting the custom build. An empty object satisfies the check.
echo '{}' > "$DIST_DIR/package.json"
ok "Wrote package.json (required by Vesktop's install validator)"

# ---------------------------------------------------------------------------
# Convert the dist path to a format the OS expects in state.json
#
# On Linux and macOS this is a no-op. On Windows (Git Bash) the shell uses
# POSIX paths like /c/Users/... but Node.js/Vesktop needs Windows paths like
# C:\Users\... — cygpath handles the conversion.
# ---------------------------------------------------------------------------

case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
        DIST_DIR_NATIVE="$(cygpath -w "$DIST_DIR")"
        ;;
    *)
        DIST_DIR_NATIVE="$DIST_DIR"
        ;;
esac

# ---------------------------------------------------------------------------
# Write vencordDir into state.json
#
# jq merges the new key into the existing JSON without touching any other
# fields (windowBounds, firstLaunch, etc.). Writing to a temp file first
# prevents truncating state.json if jq errors mid-write.
# ---------------------------------------------------------------------------

info "Setting vencordDir in $STATE_JSON"

tmp="$(mktemp)"
jq --arg dir "$DIST_DIR_NATIVE" '.vencordDir = $dir' "$STATE_JSON" > "$tmp"
mv "$tmp" "$STATE_JSON"

ok "vencordDir = $DIST_DIR_NATIVE"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

printf '\n'
info "Done. Restart Vesktop to load the Tencord build."
