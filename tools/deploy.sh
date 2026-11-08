#!/bin/zsh
# Deploy Denier Lab to https://jp.thinnking.shop/denier/ (Tokyo VM, Caddy serves /srv/denier/current).
# Same scheme as the rain page (machine notes not in this repo): each deploy is a new timestamped release and
# /srv/denier/current is switched atomically; older releases are kept.
#   rollback: ssh in and `sudo ln -sfn /srv/denier/releases/<older> /srv/denier/current`
# The Caddy block that serves /denier/ was added by hand once (backup /etc/caddy/Caddyfile.pre-denier-*).
#
# Three steps, each retried on its own because the VM's sshd now and then drops a connection during
# key exchange (2026-10-25), and each safe to repeat:
#   1. upload into a scratch dir, check the key files, then rename it to the release dir
#   2. switch `current` to it (temporary link + rename, which is atomic)
#   3. fetch the key URLs through Caddy; if any fails, switch back to the previous release
set -euo pipefail
ROOT=${0:A:h:h}
# reach the server through a jump host
VM=(ssh -i ~/.ssh/<your-key> -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15
    -J <jump-user>@<jump-host> <user>@<server>)
TS=$(date -u +%Y%m%dT%H%M%SZ)
BASE=/srv/denier
REL=$BASE/releases/$TS
FILES=(index.html style.css js/main.js js/stocking.js js/toon.js js/sound.js models/legs.glb models/legs.json
       patterns/patterns.json vendor/three/build/three.module.js)

# run a bash script on the VM (sent on stdin), retrying when ssh itself fails (exit 255)
remote() {
  local script=$1
  for try in 1 2 3 4 5 6; do
    local rc=0
    $VM "bash -s" <<<"$script" || rc=$?
    # the script's own failures (rc 1..254) are real errors: do not retry those
    [[ $rc == 0 ]] && return 0
    [[ $rc != 255 ]] && { echo "remote step failed (exit $rc)"; return $rc; }
    echo "ssh failed (attempt $try), retrying in 10 s" >&2; sleep 10
  done
  echo "ssh kept failing"; return 1
}

# COPYFILE_DISABLE keeps macOS tar from adding ._* metadata files
TAR=$(mktemp); trap 'rm -f $TAR' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs --exclude '._*' --exclude '.DS_Store' -C $ROOT/web -czf $TAR .
B64=$(base64 < $TAR | tr -d '\n')

echo "1/3 upload $TS"
remote "set -euo pipefail
if [ -d $REL ]; then echo 'already uploaded'; exit 0; fi
TMP=\$(sudo mktemp -d $BASE/releases/.upload-XXXXXX)
echo '$B64' | base64 -d | sudo tar -C \$TMP -xzf - --no-same-owner
for f in ${FILES[*]}; do sudo test -s \$TMP/\$f || { echo \"missing \$f\"; sudo rm -rf \$TMP; exit 1; }; done
sudo find \$TMP -type d -exec chmod 755 {} +
sudo find \$TMP -type f -exec chmod 644 {} +
sudo mv -T \$TMP $REL"

echo "2/3 switch"
PREV=$(remote "readlink -f $BASE/current || true" | tail -1)
remote "set -euo pipefail
sudo ln -sfn $REL $BASE/current.new
sudo mv -T $BASE/current.new $BASE/current"

echo "3/3 check (previous release: ${PREV:-none})"
CHECK="set -uo pipefail
bad=0
for f in '' ${FILES[*]}; do
  u=/denier/\$f
  code=\$(curl -s -o /dev/null -w '%{http_code}' --resolve jp.thinnking.shop:443:127.0.0.1 https://jp.thinnking.shop\$u)
  printf '%-46s %s\n' \$u \$code
  [ \"\$code\" = 200 ] || bad=1
done
exit \$bad"
if ! remote "$CHECK"; then
  if [[ -n $PREV && $PREV != $REL ]]; then
    echo "check failed: switching back to $PREV"
    remote "set -euo pipefail; sudo ln -sfn $PREV $BASE/current.new; sudo mv -T $BASE/current.new $BASE/current"
  fi
  exit 1
fi
echo "deployed release $TS -> https://jp.thinnking.shop/denier/"
