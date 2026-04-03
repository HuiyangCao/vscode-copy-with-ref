#!/bin/bash
set -e
cd "$(dirname "$0")"

npm run compile
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
PUBLISHER=$(node -p "require('./package.json').publisher")
VSIX="${NAME}-${VERSION}.vsix"
OLD_VSIX="copy-with-ref-${VERSION}.vsix"
vsce package --no-dependencies

if command -v code &>/dev/null; then
    code --uninstall-extension "${PUBLISHER}.copy-with-ref" 2>/dev/null || true
    code --uninstall-extension "${PUBLISHER}.${NAME}" 2>/dev/null || true
    code --install-extension "$VSIX"
fi

if command -v cursor &>/dev/null; then
    cursor --uninstall-extension "${PUBLISHER}.copy-with-ref" 2>/dev/null || true
    cursor --uninstall-extension "${PUBLISHER}.${NAME}" 2>/dev/null || true
    cursor --install-extension "$VSIX" 2>/dev/null || true
fi

echo "Done. Reload window to take effect."
