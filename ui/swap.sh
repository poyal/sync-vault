#!/bin/sh
set -eu
parent=$1 target=$2 replacement=$3 container=$4 profile=$5 transaction=$6 ticket=$7
[ "$(dirname "$container")" = "$(dirname "$target")" ]
[ "$replacement" = "$container/new/Sync Vault.app" ]
case "$(basename "$container")" in .syncvault-update-*) ;; *) exit 2;; esac
echo "$" > "$transaction/started"
while kill -0 "$parent" 2>/dev/null; do sleep 0.2; done
mv "$target" "$container/previous"
rollback() {
    if [ -d "$target" ]; then mv "$target" "$container/failed"; fi
    mv "$container/previous" "$target"
    for name in state.json state.json.bak; do
        if [ -f "$transaction/$name" ]; then cp "$transaction/$name" "$profile/$name"; fi
    done
    echo 'Update rolled back' > "$transaction/failed.txt"
    open "$target" --args "--user-data-dir=$profile"
}
if ! mv "$replacement" "$target"; then rollback; exit 1; fi
set -- "--user-data-dir=$profile"
if [ "${SYNC_VAULT_QA_MOCK_KEYCHAIN:-}" = 1 ]; then set -- "$@" --use-mock-keychain; fi
SYNC_VAULT_HEALTH="$transaction" SYNC_VAULT_TICKET="$ticket" "$target/Contents/MacOS/Sync Vault" "$@" >/dev/null 2>&1 &
pid=$!
attempt=0
while :; do
    if [ -f "$transaction/healthy" ] && [ "$(cat "$transaction/healthy")" = "$ticket" ]; then
        rm -rf "$container/previous"
        rm -f "$transaction/update.zip" "$transaction/state.json" "$transaction/state.json.bak"
        echo "$ticket" > "$transaction/complete"
        exit 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    attempt=$((attempt+1))
    if [ "$attempt" -ge 180 ]; then kill "$pid" 2>/dev/null || true; wait "$pid" || true; break; fi
    sleep 0.5
done
rollback
exit 1

