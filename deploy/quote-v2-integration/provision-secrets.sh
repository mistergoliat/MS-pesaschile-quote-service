#!/usr/bin/env bash
# Quote V2 EC2 integration: generate every greenfield secret ON THE HOST.
# Prints no secret value. Refuses to overwrite an existing secrets directory.
# Requires: openssl, jq, docker, passwordless sudo (for container-uid ownership),
# and the image quote-v2-integration:6735352 already loaded.
set -euo pipefail
umask 077

DIR="${QUOTE_V2_SECRETS_DIR:-$HOME/.config/quote-v2-integration}"
IMAGE="quote-v2-integration:6735352"
DB_HOST="quote-v2-integration-postgres"
DB_NAME="quote_v2_integration"

if [ -e "$DIR" ]; then
  echo "refusing: $DIR already exists" >&2
  exit 1
fi
mkdir -p "$DIR/pg-tls"
chmod 700 "$DIR"
cd "$DIR"

rand() { openssl rand -hex 32; }

# PostgreSQL passwords (hex: URL-safe, no encoding).
rand > pg-superuser-password
rand > migrator-password
rand > app-password

printf 'DATABASE_URL=postgres://quote_app:%s@%s:5432/%s\n' "$(cat app-password)" "$DB_HOST" "$DB_NAME" > runtime.secret.env
printf 'MIGRATION_DATABASE_URL=postgres://quote_migrator:%s@%s:5432/%s\n' "$(cat migrator-password)" "$DB_HOST" "$DB_NAME" > migration.secret.env

# Private CA + server certificate for the internal Postgres (verify-full).
# The CA key exists only for signing and is destroyed immediately.
(
  cd pg-tls
  openssl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out ca.crt -days 365 \
    -subj "/CN=quote-v2-integration-db-ca" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  openssl req -newkey rsa:3072 -nodes -keyout server.key -out server.csr -subj "/CN=$DB_HOST" 2>/dev/null
  printf 'subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$DB_HOST" > server.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -extfile server.ext 2>/dev/null
  openssl verify -CAfile ca.crt server.crt >/dev/null
  shred -u ca.key 2>/dev/null || rm -f ca.key
  rm -f server.csr server.ext ca.srl
  chmod 644 ca.crt server.crt
)
chmod 755 pg-tls

# Principals: raw tokens stay in 0600 files; only hashes enter the registry.
gen_token() {
  docker run --rm --network none --entrypoint node "$IMAGE" dist/scripts/generate-principal-token.js
}
gen_token > .synthetic.json
gen_token > .monitor.json
jq -r .token .synthetic.json > token-synthetic
jq -r .token .monitor.json > token-monitor
jq -n --arg s "$(jq -r .tokenSha256 .synthetic.json)" --arg m "$(jq -r .tokenSha256 .monitor.json)" '{
  version: 1,
  principals: [
    { principalId: "quote-g1-synthetic", principalType: "service",
      scopes: ["quotes:create", "quotes:draft:write", "quotes:issue", "quotes:read", "quotes:document:read"],
      tokenSha256: [$s] },
    { principalId: "quote-g1-monitor", principalType: "service",
      scopes: ["service:health:dependencies"],
      tokenSha256: [$m] }
  ]
}' > principals.json
shred -u .synthetic.json .monitor.json 2>/dev/null || rm -f .synthetic.json .monitor.json

# Container-side readers: postgres = uid 70, nodeapp = uid 999.
sudo -n chown 70:70 pg-tls/server.key pg-superuser-password
sudo -n chmod 400 pg-tls/server.key pg-superuser-password
sudo -n chown 999:999 principals.json
sudo -n chmod 400 principals.json

echo "provisioned: $(ls -1 | tr '\n' ' ')pg-tls/{$(ls -1 pg-tls | tr '\n' ' ')}"
