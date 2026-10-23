#!/usr/bin/env bash
# Fetches Google Docs/Slides templates from Drive by id (read-only, paced) as .docx/.pptx and
# registers each under its Drive id in the local file store, so the legacy code's
# DriveApp.getFileById(<id>).makeCopy(...) finds a real file.
#
#   bash tools/fetch-templates-by-id.sh <ids file> [<work dir>]
#
# <ids file>: one Drive id per line (the Certificates and stages sheets name their templates
# by bare id; tools/list-referenced-ids.js lists them, and the import's missing-ids.txt names
# the ones still absent). Needs the rclone remote `gdrive` (docs/DEPLOY.md section 4, step 1).
# The general by-id fetch exports Google-native files as PDF, which is right for documents the
# app only serves, and wrong for templates: the generator needs the editable .docx/.pptx.
set -euo pipefail

ids_file=${1:?usage: fetch-templates-by-id.sh <ids file> [<work dir>]}
work_dir=${2:-/tmp/basaer-templates-by-id}
cd "$(dirname "$0")/.."
mkdir -p "$work_dir"
registered=0; failed=0
while read -r id; do
  [ -z "$id" ] && continue
  mkdir -p "$work_dir/$id"
  if [ -z "$(ls -A "$work_dir/$id")" ]; then
    # A trailing slash keeps the file's own name; the export adds the extension.
    if ! rclone backend copyid gdrive: "$id" "$work_dir/$id/" --drive-export-formats docx,pptx --tpslimit 3 >/dev/null 2>"$work_dir/$id.err"; then
      echo "FETCH FAILED $id: $(head -c 200 "$work_dir/$id.err")"; failed=$((failed + 1)); continue
    fi
  fi
  file=$(ls -A "$work_dir/$id" | head -1)
  if node tools/register-template.js --id "$id" --file "$work_dir/$id/$file" >/dev/null 2>"$work_dir/$id.reg.err"; then
    echo "ok   $id  $file"; registered=$((registered + 1))
  else
    echo "REGISTER FAILED $id ($file): $(head -c 200 "$work_dir/$id.reg.err")"; failed=$((failed + 1))
  fi
done < "$ids_file"
echo "registered $registered, failed $failed"
[ "$failed" -eq 0 ]
