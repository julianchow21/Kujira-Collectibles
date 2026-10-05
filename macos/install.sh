#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_ROOT="${COLLECTIBLES_BUILD_ROOT:-$SCRIPT_DIR/Build}"
SOURCE_APP="$BUILD_ROOT/Collectibles Desktop.app"
INSTALL_ROOT="/Users/julianchow/Applications"
DEST_APP="$INSTALL_ROOT/Collectibles Desktop.app"
LEGACY_CHROME_APP="/Users/julianchow/Applications/Chrome Apps.localized/Kujira Collectibles.app"

usage() {
    cat <<'EOF'
Usage:
  zsh macos/install.sh --dry-run   verify the staged app and show the copy plan
  zsh macos/install.sh --install   copy the staged app into Applications

The install command refuses to overwrite an existing Collectibles Desktop.app, never
touches the legacy Chrome app, and never opens or terminates an app.
EOF
}

require_candidate() {
    [[ -d "$SOURCE_APP" ]] || {
        echo "staged app missing: $SOURCE_APP" >&2
        echo "build it first with: zsh macos/build.sh all" >&2
        return 1
    }
    [[ "$DEST_APP" != "$LEGACY_CHROME_APP" ]] || {
        echo "refusing to target the legacy Chrome app" >&2
        return 1
    }
    /usr/bin/plutil -lint "$SOURCE_APP/Contents/Info.plist" >/dev/null
    /usr/bin/codesign --verify --deep --strict "$SOURCE_APP"

    local bundle_id display_name executable
    bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SOURCE_APP/Contents/Info.plist")"
    display_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$SOURCE_APP/Contents/Info.plist")"
    executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$SOURCE_APP/Contents/Info.plist")"
    [[ "$bundle_id" == "com.kujira.collectibles.desktop" ]] || {
        echo "unexpected bundle identifier: $bundle_id" >&2
        return 1
    }
    [[ "$display_name" == "Collectibles Desktop" ]] || {
        echo "unexpected display name: $display_name" >&2
        return 1
    }
    [[ "$executable" == "Collectibles" && -x "$SOURCE_APP/Contents/MacOS/Collectibles" ]] || {
        echo "staged executable is missing or misnamed" >&2
        return 1
    }
}

show_plan() {
    echo "source=$SOURCE_APP"
    echo "destination=$DEST_APP"
    echo "legacy-preserved=$LEGACY_CHROME_APP"
}

case "${1:---dry-run}" in
    --dry-run)
        require_candidate
        show_plan
        echo "install-plan=valid"
        echo "No files copied."
        ;;
    --install)
        require_candidate
        [[ ! -e "$DEST_APP" ]] || {
            echo "refusing to overwrite existing destination: $DEST_APP" >&2
            exit 1
        }
        if /usr/bin/pgrep -x Collectibles >/dev/null 2>&1; then
            echo "Collectibles Desktop is running, refusing to copy over a live app" >&2
            exit 1
        fi
        /bin/mkdir -p "$INSTALL_ROOT"
        /usr/bin/ditto "$SOURCE_APP" "$DEST_APP"
        /usr/bin/plutil -lint "$DEST_APP/Contents/Info.plist" >/dev/null
        /usr/bin/codesign --verify --deep --strict "$DEST_APP"
        echo "install=pass"
        echo "installed=$DEST_APP"
        echo "The app was copied only. It was not opened or added to the Dock."
        ;;
    -h|--help)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
