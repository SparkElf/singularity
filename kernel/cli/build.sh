#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KERNEL_DIR="$(dirname "$SCRIPT_DIR")"
cd "$KERNEL_DIR"

export GO111MODULE=on
export CGO_ENABLED=1

build_local() {
    echo "Building for local platform..."
    go build -tags fts5 -ldflags "-s -w" -o siyuan ./cli
    echo "Done: siyuan"
}

build_windows() {
    echo "Building Windows amd64..."
    GOOS=windows GOARCH=amd64 go build -tags fts5 -ldflags "-s -w" -o siyuan-win-amd64.exe ./cli
    echo "Done: siyuan-win-amd64.exe"
}

build_linux() {
    echo "Building Linux amd64..."
    GOOS=linux GOARCH=amd64 go build -tags fts5 -ldflags "-s -w" -o siyuan-linux-amd64 ./cli
    echo "Done: siyuan-linux-amd64"

    echo "Building Linux arm64..."
    GOOS=linux GOARCH=arm64 go build -tags fts5 -ldflags "-s -w" -o siyuan-linux-arm64 ./cli
    echo "Done: siyuan-linux-arm64"
}

build_darwin() {
    echo "Building macOS amd64..."
    GOOS=darwin GOARCH=amd64 go build -tags fts5 -ldflags "-s -w" -o siyuan-darwin-amd64 ./cli
    echo "Done: siyuan-darwin-amd64"

    echo "Building macOS arm64..."
    GOOS=darwin GOARCH=arm64 go build -tags fts5 -ldflags "-s -w" -o siyuan-darwin-arm64 ./cli
    echo "Done: siyuan-darwin-arm64"
}

TARGET="${1:-local}"

case "$TARGET" in
    local)   build_local ;;
    windows) build_windows ;;
    linux)   build_linux ;;
    darwin)  build_darwin ;;
    all)
        build_windows
        build_linux
        build_darwin
        ;;
    *)
        echo "Usage: $0 [local|windows|linux|darwin|all]"
        echo "  local   Build for current platform (default)"
        echo "  windows Build Windows amd64"
        echo "  linux   Build Linux amd64 + arm64"
        echo "  darwin  Build macOS amd64 + arm64"
        echo "  all     Build all platforms"
        exit 1
        ;;
esac

echo ""
echo "Build complete."
