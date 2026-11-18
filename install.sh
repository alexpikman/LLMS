#!/usr/bin/env bash
set -euo pipefail

# vLLM Gateway — Universal Auto-Installer for Linux & macOS
# Replace <OWNER>/<REPO> with your GitHub repository slug:
#   VLLM_REPO="your-org/your-repo" curl -fsSL https://raw.githubusercontent.com/your-org/your-repo/main/install.sh | bash
# Or run from a cloned repository:
#   ./install.sh
# Uninstall binary (preserves downloaded models unless --purge is passed):
#   ./install.sh --uninstall

REPO="${VLLM_REPO:-}"
INSTALL_DIR="${VLLM_INSTALL_DIR:-$HOME/.local/share/vllm-gateway}"
BIN_LINK_DIR="${VLLM_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${VLLM_DATA_DIR:-$HOME/.vllm-gateway}"
UNINSTALL=0
PURGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --purge)
      PURGE=1
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$UNINSTALL" -eq 1 ]]; then
  echo "==> Uninstalling vLLM Gateway..."
  rm -f "$BIN_LINK_DIR/vllm-gateway"
  rm -rf "$INSTALL_DIR"
  if [[ "$PURGE" -eq 1 ]]; then
    rm -rf "$DATA_DIR"
    echo "Removed binary and $DATA_DIR."
  else
    echo "Removed binary. Preserved models and config in $DATA_DIR (pass --purge to remove)."
  fi
  exit 0
fi

if [[ -z "$REPO" ]] && command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ORIGIN_URL=$(git config --get remote.origin.url || true)
  if [[ "$ORIGIN_URL" =~ github\.com[:/]([^/]+/[^/.]+) ]]; then
    REPO="${BASH_REMATCH[1]}"
  fi
fi

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  linux) PLATFORM="linux" ;;
  darwin) PLATFORM="macos" ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH_TAG="x64" ;;
  arm64|aarch64) ARCH_TAG="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

TARGET="${PLATFORM}-${ARCH_TAG}"
ASSET_NAME="vllm-gateway-${TARGET}.tar.gz"

echo "==> vLLM Gateway Installer ($TARGET)"
mkdir -p "$INSTALL_DIR" "$BIN_LINK_DIR" "$DATA_DIR/models" "$DATA_DIR/bin" "$DATA_DIR/archives" "$DATA_DIR/logs"

INSTALLED=0

if [[ -n "$REPO" ]]; then
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
  SUMS_URL="https://github.com/${REPO}/releases/latest/download/SHA256SUMS.txt"
  echo "==> Downloading latest GitHub Release binary: $DOWNLOAD_URL"
  TMP_DIR="$(mktemp -d)"
  TMP_ARCHIVE="$TMP_DIR/$ASSET_NAME"
  if curl -fsSL "$DOWNLOAD_URL" -o "$TMP_ARCHIVE"; then
    if curl -fsSL "$SUMS_URL" -o "$TMP_DIR/SHA256SUMS.txt"; then
      EXPECTED=$(grep " ${ASSET_NAME}\$" "$TMP_DIR/SHA256SUMS.txt" | awk '{print $1}' || true)
      if [[ -n "$EXPECTED" ]]; then
        ACTUAL=""
        if command -v sha256sum >/dev/null 2>&1; then
          ACTUAL=$(sha256sum "$TMP_ARCHIVE" | awk '{print $1}')
        elif command -v shasum >/dev/null 2>&1; then
          ACTUAL=$(shasum -a 256 "$TMP_ARCHIVE" | awk '{print $1}')
        fi
        if [[ -n "$ACTUAL" && "$ACTUAL" != "$EXPECTED" ]]; then
          echo "Error: SHA-256 checksum mismatch for $ASSET_NAME!"
          rm -rf "$TMP_DIR"
          exit 1
        fi
        echo "==> SHA-256 checksum verified."
      fi
    fi
    rm -rf "$INSTALL_DIR"/*
    tar -xzf "$TMP_ARCHIVE" -C "$INSTALL_DIR"
    chmod +x "$INSTALL_DIR/vllm-gateway"
    rm -rf "$TMP_DIR"
    INSTALLED=1
  else
    rm -rf "$TMP_DIR"
    echo "Warning: Prebuilt binary not found at $DOWNLOAD_URL."
  fi
fi

if [[ "$INSTALLED" -eq 0 ]]; then
  if [[ -f "./package.json" ]] && command -v node >/dev/null 2>&1; then
    echo "==> Building standalone binary locally from source..."
    npm ci
    npm run build:release
    rm -rf "$INSTALL_DIR"/*
    cp -R release-build/* "$INSTALL_DIR/"
    chmod +x "$INSTALL_DIR/vllm-gateway"
    INSTALLED=1
  else
    echo "Error: Specify VLLM_REPO=\"owner/repo\" with a published GitHub Release, or run install.sh from the cloned project directory with Node.js 22+."
    exit 1
  fi
fi

# Copy bundled vendor/llama-server archives (if provided in repo/release) into DATA_DIR/archives
for VENDOR_DIR in "./vendor/llama-server" "$INSTALL_DIR/vendor/llama-server"; do
  if [[ -d "$VENDOR_DIR" ]]; then
    for ARC in "$VENDOR_DIR"/*.tar.gz "$VENDOR_DIR"/*.tgz "$VENDOR_DIR"/*.zip; do
      if [[ -f "$ARC" ]]; then
        cp -f "$ARC" "$DATA_DIR/archives/"
        echo "==> Copied local llama-server archive to $DATA_DIR/archives/$(basename "$ARC")"
      fi
    done
  fi
done

cat > "$BIN_LINK_DIR/vllm-gateway" <<EOF
#!/usr/bin/env bash
export NODE_ENV=production
export VLLM_DIST_DIR="${INSTALL_DIR}/dist"
export VLLM_DATA_DIR="${DATA_DIR}"
exec "${INSTALL_DIR}/vllm-gateway" "\$@"
EOF
chmod +x "$BIN_LINK_DIR/vllm-gateway"

echo ""
echo "Installation complete!"
echo "  Binary:      $BIN_LINK_DIR/vllm-gateway"
echo "  Data dir:    $DATA_DIR"
echo "  Models dir:  $DATA_DIR/models"
echo "  Archives:    $DATA_DIR/archives"
echo ""
if [[ ":$PATH:" != *":$BIN_LINK_DIR:"* ]]; then
  echo "Add $BIN_LINK_DIR to your PATH:"
  echo "  export PATH=\"$BIN_LINK_DIR:\$PATH\""
  echo ""
fi
echo "Start the server with:"
echo "  vllm-gateway"
echo "Then open http://localhost:3003 in your browser (or set VLLM_API_KEY env var)."
