#!/bin/sh
# Confirms vendor/operating-model-simulator is byte-for-byte the upstream engine at the
# commit named in src/engine.ts. Needs git and network access.
set -e
COMMIT=$(sed -n "s/^export const ENGINE_COMMIT = '\([0-9a-f]*\)';/\1/p" src/engine.ts)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone --quiet https://github.com/bsunter93/operating-model-simulator "$TMP/up"
git -C "$TMP/up" checkout --quiet "$COMMIT"
status=0
for f in $(cd vendor/operating-model-simulator && find . -type f | sort); do
  if ! cmp -s "vendor/operating-model-simulator/$f" "$TMP/up/$f"; then
    echo "differs from upstream: $f"
    status=1
  fi
done
[ $status -eq 0 ] && echo "vendor matches operating-model-simulator@$COMMIT"
exit $status
