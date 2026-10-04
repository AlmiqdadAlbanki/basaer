#!/usr/bin/env bash
# Pulls the real Basaer data out of Google Drive with rclone (read-only scope).
#
#   bash tools/google-exports.sh setup
#   bash tools/google-exports.sh pull [--out data/google-exports]
#   bash tools/google-exports.sh discover
#
# The files to pull are listed in tools/google-files.json. Anything the admin has
# not shared with your Google account is reported, not fatal: share it and run
# pull again (it is idempotent). Then run tools/import-google-exports.js.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$script_dir/.." && pwd)
manifest=$script_dir/google-files.json
remote=gdrive

usage() {
  echo "usage: bash tools/google-exports.sh setup | pull [--out <dir>] | discover" >&2
  exit 2
}

need_remote() {
  if ! rclone listremotes | grep -qx "$remote:"; then
    echo "rclone remote '$remote' is not configured. Run first: bash tools/google-exports.sh setup" >&2
    exit 1
  fi
}

cmd_setup() {
  if rclone listremotes | grep -qx "$remote:"; then
    echo "rclone remote '$remote' already exists, nothing to do."
    return
  fi
  # drive.readonly: this tool must never be able to change anything in Drive.
  rclone config create "$remote" drive scope drive.readonly config_is_local false
  cat <<EOF

Remote '$remote' created but not authorised yet. Pick one:

  1. Machine with a browser (a laptop, or WSL with a browser available):
       rclone config reconnect $remote:
     and sign in with the Google account the admin shared the files with.

  2. Headless machine (a server): on a machine WITH a browser and rclone, run
       rclone authorize "drive" "" "" --drive-scope drive.readonly
     sign in, copy the token JSON it prints, then on this machine run
       rclone config reconnect $remote:
     and paste the token when it asks for the result of 'rclone authorize'.

Check it works with:  rclone lsd $remote:
EOF
}

# Maps rclone's stderr text to one short status. Matches both the HTTP codes and
# the Google error reasons, because rclone prints either depending on the call.
classify_error() {
  local text=$1
  if echo "$text" | grep -qiE '403|forbidden|insufficientFilePermissions|does not have permission|rateLimitExceeded.*sharing'; then
    echo "ACCESS DENIED (not shared with you)"
  elif echo "$text" | grep -qiE '404|notFound|not found|directory not found|couldn.t find'; then
    echo "NOT FOUND"
  else
    local first_line
    first_line=$(echo "$text" | grep -v '^$' | tail -n 1 | cut -c1-120)
    echo "ERROR ${first_line:-unknown}"
  fi
}

cmd_pull() {
  local out_dir=$repo_dir/data/google-exports
  while [ $# -gt 0 ]; do
    case $1 in
      --out) out_dir=$2; shift 2 ;;
      *) usage ;;
    esac
  done
  need_remote
  mkdir -p "$out_dir/folders"

  local summary=() ok_count=0 error_file
  error_file=$(mktemp)
  trap 'rm -f "$error_file"' RETURN

  # One line per entry: name <TAB> id <TAB> kind.
  local entries
  entries=$(node -e '
    for (const e of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))
      console.log([e.name, e.id, e.kind].join("\t"));
  ' "$manifest")

  local name id kind status extension
  while IFS=$'\t' read -r name id kind; do
    [ -n "$name" ] || continue
    status=OK
    case $kind in
      sheet|doc|slides)
        case $kind in sheet) extension=xlsx ;; doc) extension=docx ;; slides) extension=pptx ;; esac
        # copyid runs rclone copyto, which exports Google-native files using
        # --drive-export-formats; the target name keeps the logical name.
        if ! rclone backend copyid "$remote:" "$id" "$out_dir/$name.$extension" \
              --drive-export-formats xlsx,docx,pptx 2>"$error_file" >/dev/null; then
          status=$(classify_error "$(cat "$error_file")")
        elif [ ! -s "$out_dir/$name.$extension" ]; then
          status="ERROR empty file"
        fi
        ;;
      folder)
        # The listing keeps the original Google ids, which the importer needs to
        # recreate the same folder/file ids locally. Same export format as the copy
        # so both agree on the names of Google-native files (name.pdf).
        if ! rclone lsjson -R --drive-root-folder-id "$id" --drive-export-formats pdf "$remote:" \
              >"$out_dir/folders/$name.lsjson" 2>"$error_file"; then
          status=$(classify_error "$(cat "$error_file")")
          rm -f "$out_dir/folders/$name.lsjson"
        elif ! rclone copy "$remote:" "$out_dir/folders/$name/" --drive-root-folder-id "$id" \
              --drive-export-formats pdf 2>"$error_file" >/dev/null; then
          status=$(classify_error "$(cat "$error_file")")
        fi
        ;;
      *)
        status="ERROR unknown kind '$kind' in manifest"
        ;;
    esac
    [ "$status" = OK ] && ok_count=$((ok_count + 1))
    summary+=("$(printf '%-30s %-7s %s' "$name" "$kind" "$status")")
  done <<<"$entries"

  echo
  printf '%-30s %-7s %s\n' NAME KIND RESULT
  printf '%s\n' "${summary[@]}"
  echo
  echo "$ok_count of ${#summary[@]} succeeded. Output: $out_dir"
  [ "$ok_count" -gt 0 ] || exit 1
}

# Adds the greeting-card Slides templates (ids live in the refID sheet, not in
# code) to the manifest. Needs refID imported first, so the order is:
# pull, import, discover, pull.
cmd_discover() {
  local ids
  ids=$(node "$script_dir/list-greeting-template-ids.js")
  if [ -z "$ids" ]; then
    echo "No greeting template ids found. Import refID first (pull, then import), then run discover again."
    return
  fi
  MANIFEST=$manifest node -e '
    const fs = require("fs");
    const manifestPath = process.env.MANIFEST;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const ids = fs.readFileSync(0, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    let added = 0;
    for (const id of ids) {
      if (manifest.some((e) => e.id === id)) continue;
      const name = "greetingTemplate" + String(manifest.filter((e) => e.kind === "slides").length + 1).padStart(2, "0");
      manifest.push({ name, id, kind: "slides", registerAs: id });
      added++;
      console.log("added " + name + " (" + id + ")");
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(added + " new greeting template(s); " + (ids.length - added) + " already in the manifest.");
  ' <<<"$ids"
}

[ $# -ge 1 ] || usage
subcommand=$1
shift
case $subcommand in
  setup) cmd_setup ;;
  pull) cmd_pull "$@" ;;
  discover) cmd_discover ;;
  *) usage ;;
esac
