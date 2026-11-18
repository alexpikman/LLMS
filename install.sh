#!/usr/bin/env bash
set -euo pipefail

# vLLM Gateway — Universal Auto-Installer for Linux & macOS
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<OWNER>/<REPO>/main/install.sh | bash
# Or override repository:
#   VLLM_REPO="owner/repo" bash install.sh

REPO="${VLLM_REPO:-}"
INSTALL_DIR="${VLLM_INSTALL_DIR:-$HOME/.local/share/vllm-gateway}"
BIN_LINK_DIR="${VLLM_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${VLLM_DATA_DIR:-$HOME/.vllm-gateway}"

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
    *)
      shift
      ;;
  esac
done

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
mkdir -p "$INSTALL_DIR" "$BIN_LINK_DIR" "$DATA_DIR/models" "$DATA_DIR/bin"

INSTALLED=0

if [[ -n "$REPO" ]]; then
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
  echo "==> Downloading latest GitHub Release binary: $DOWNLOAD_URL"
  TMP_ARCHIVE="$(mktemp)"
  if curl -fsSL "$DOWNLOAD_URL" -o "$TMP_ARCHIVE"; then
    rm -rf "$INSTALL_DIR"/*
    tar -xzf "$TMP_ARCHIVE" -C "$INSTALL_DIR"
    chmod +x "$INSTALL_DIR/vllm-gateway"
    rm -f "$TMP_ARCHIVE"
    INSTALLED=1
  else
    rm -f "$TMP_ARCHIVE"
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
echo "  Models dir:  $DATA_DIR/models"
echo ""
if [[ ":$PATH:" != *":$BIN_LINK_DIR:"* ]]; then
  echo "Add $BIN_LINK_DIR to your PATH:"
  echo "  export PATH=\"$BIN_LINK_DIR:\$PATH\""
  echo ""
fi
echo "Start the server with:"
echo "  vllm-gateway"
echo "Then open http://localhost:3000 in your browser."
