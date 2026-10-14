#!/bin/sh
# Build the extension for loading/uploading: ./package.sh
#   watchparty-vX.Y.Z/        unpacked, KEEPS "key" (fixed dev extension id)
#   watchparty-vX.Y.Z.zip     Chrome Web Store upload — "key" REMOVED (the
#                             store item has its own key and rejects ours)
set -e
cd "$(dirname "$0")"
V=$(node -p 'require("./manifest.json").version')
D="watchparty-v$V"
rm -rf "$D" "$D.zip"
mkdir "$D"
cp -R manifest.json background.js content.js content.css frame-agent.js page-bridge.js sidebar lib icons "$D/"
find "$D" -name .DS_Store -delete
STAGE=$(mktemp -d)
cp -R "$D/." "$STAGE/"
node -e '
  const fs = require("fs"), f = process.argv[1];
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  delete m.key;
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");
' "$STAGE/manifest.json"
(cd "$STAGE" && zip -qr - .) > "$D.zip"
rm -rf "$STAGE"
echo "Built $D/ (dev, with key) and $D.zip (Web Store, no key)"
