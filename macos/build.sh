#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="${COLLECTIBLES_BUILD_ROOT:-$SCRIPT_DIR/Build}"
APP_BUNDLE="$BUILD_ROOT/Collectibles Desktop.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
EXECUTABLE="$CONTENTS_DIR/MacOS/Collectibles"
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
TARGET="arm64-apple-macosx13.0"

die() {
    echo "$1" >&2
    return 1
}

validate_build_root() {
    [[ "$BUILD_ROOT" = /* ]] || die "build root must be an absolute path: $BUILD_ROOT"
    [[ ! -L "$BUILD_ROOT" ]] || die "refusing symlink build root: $BUILD_ROOT"

    if [[ "$BUILD_ROOT" == "$SCRIPT_DIR"/* ]]; then
        local relative_root="${BUILD_ROOT#"$SCRIPT_DIR/"}"
        [[ "$relative_root" == "Build" || "$relative_root" == Build-* ]] || {
            die "build root must be an immediate macos/Build* staging directory: $BUILD_ROOT"
        }
        [[ "$relative_root" != */* ]] || {
            die "build root must be an immediate macos/Build* staging directory: $BUILD_ROOT"
        }
        return 0
    fi

    if [[ "$BUILD_ROOT" == /private/tmp/kujira-collectibles-desktop-build* ]]; then
        local temporary_root="${BUILD_ROOT#/private/tmp/}"
        [[ "$temporary_root" != */* ]] || {
            die "temporary build root must be directly under /private/tmp: $BUILD_ROOT"
        }
        return 0
    fi

    die "build root is outside the allowed staging locations: $BUILD_ROOT"
}

prepare_build_root() {
    validate_build_root
    [[ ! -e "$BUILD_ROOT" && ! -L "$BUILD_ROOT" ]] || {
        die "refusing to reuse existing build root: $BUILD_ROOT"
    }
    mkdir "$BUILD_ROOT" || die "unable to claim build root, it appeared during setup: $BUILD_ROOT"
}

build_app() {
    mkdir -p "$CONTENTS_DIR/MacOS" "$RESOURCES_DIR"

    swiftc \
        -parse-as-library \
        -O \
        -target "$TARGET" \
        -sdk "$SDK_PATH" \
        -module-cache-path "$BUILD_ROOT/module-cache" \
        -framework AppKit \
        -framework Foundation \
        -framework WebKit \
        "$SCRIPT_DIR/DesktopCore.swift" \
        "$SCRIPT_DIR/WindowSizing.swift" \
        "$SCRIPT_DIR/main.swift" \
        -o "$EXECUTABLE"

    cp "$SCRIPT_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"

    local icon_source="$PROJECT_DIR/Assets/whale-icon.png"
    # sips creates a valid multi-size icns directly. This avoids depending on
    # iconutil accepting a generated iconset on every supported macOS SDK.
    sips -s format icns "$icon_source" --out "$RESOURCES_DIR/ApplicationIcon.icns" >/dev/null

    codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null
}

run_tests() {
    local test_root
    test_root="$(mktemp -d /private/tmp/kujira-collectibles-desktop-tests.XXXXXX)"
    trap 'rm -rf "$test_root"' EXIT INT TERM
    mkdir -p "$test_root"

    swiftc \
        -O \
        -target "$TARGET" \
        -sdk "$SDK_PATH" \
        -module-cache-path "$test_root/module-cache" \
        -D COLLECTIBLES_DESKTOP_TEST \
        "$SCRIPT_DIR/DesktopCore.swift" \
        "$SCRIPT_DIR/LauncherTests.swift" \
        -o "$test_root/launcher-tests"

    "$test_root/launcher-tests"
    trap - EXIT INT TERM
    rm -rf "$test_root"
}

verify_app() {
    [[ -x "$EXECUTABLE" ]] || { echo "missing executable: $EXECUTABLE" >&2; return 1; }
    [[ -f "$RESOURCES_DIR/ApplicationIcon.icns" ]] || { echo "missing application icon" >&2; return 1; }
    /usr/bin/plutil -lint "$CONTENTS_DIR/Info.plist"
    codesign --verify --deep --strict "$APP_BUNDLE"

    local bundle_id
    bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$CONTENTS_DIR/Info.plist")"
    [[ "$bundle_id" == "com.kujira.collectibles.desktop" ]] || {
        echo "unexpected bundle identifier: $bundle_id" >&2
        return 1
    }

    local display_name
    display_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$CONTENTS_DIR/Info.plist")"
    [[ "$display_name" == "Collectibles Desktop" ]] || {
        echo "unexpected display name: $display_name" >&2
        return 1
    }

    if strings "$EXECUTABLE" | grep -E -q 'localhost|odysseus-chrome-qa|com\.google\.Chrome'; then
        echo "forbidden QA/browser marker found in launcher binary" >&2
        return 1
    fi
    if ! strings "$EXECUTABLE" | grep -F -q 'https://julianchow21.github.io/Kujira-Collectibles/'; then
        echo "production URL missing from launcher binary" >&2
        return 1
    fi

    echo "launcher-verify=pass"
    echo "bundle=$APP_BUNDLE"
    echo "bundle-id=$bundle_id"
}

case "${1:-app}" in
    app)
        prepare_build_root
        build_app
        ;;
    test)
        run_tests
        ;;
    verify)
        validate_build_root
        verify_app
        ;;
    all)
        prepare_build_root
        build_app
        run_tests
        verify_app
        ;;
    *)
        echo "usage: $0 {app|test|verify|all}" >&2
        exit 2
        ;;
esac
