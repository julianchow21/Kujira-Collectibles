#!/bin/bash
# Static QC for Collectibles. Run from the project root: ./qc.sh (exit 0 = pass)
cd "$(dirname "$0")" || exit 1
fail=0

echo "- syntax"
node --check app.js || fail=1
node --check features.js || fail=1

echo "- index.html structure"
s=$(grep -c '<style' index.html)
[ "$s" -eq 0 ] || { echo "FAIL: $s inline <style> block(s), CSS belongs in styles.css"; fail=1; }
b=$(grep -c '<script>' index.html)
[ "$b" -le 2 ] || { echo "FAIL: $b bare <script> blocks, allowed 2 (Sentry init, theme bootstrap)"; fail=1; }

echo "- cache-bust matches badge"
ver=$(grep 'id="app-ver"' index.html | sed 's/.*>v\([0-9][0-9.]*\) .*/\1/')
for f in styles.css app.js features.js; do
  grep -qF "$f?v=$ver" index.html || { echo "FAIL: $f tag is not ?v=$ver"; fail=1; }
done

echo "- duplicate DOM ids (warn only)"
grep -o 'id="[^"]*"' index.html | sort | uniq -d

if [ "$fail" -eq 0 ]; then echo "QC PASS"; else echo "QC FAIL"; exit 1; fi
