#!/usr/bin/env bash
# NOT auto-run by anything — this makes live changes to your Cloudflare
# account (DNS records, Zero Trust Access apps) and should be run
# deliberately, once, by a human (or by Claude with your explicit go-ahead
# in that turn).
#
# Required env vars before running:
#   CLOUDFLARE_API_TOKEN   - from ~/Documents/credentials/cloudflare/credentials
#   CLOUDFLARE_ACCOUNT_ID  - from the same file
#   WSERVER_PUBLIC_IP      - the public IP that reaches wserver:443 (after your
#                             router's port-forward is set up)
#   DVD_API_KEY            - the same key you export before running
#                             deploy/wserver/03-build-and-run.sh
#   ADDITIONAL_ALLOWED_EMAILS - optional, comma-separated, the list you said
#                             you'd provide for Cloudflare Access
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"
: "${WSERVER_PUBLIC_IP:?}"
: "${DVD_API_KEY:?}"
ADDITIONAL_ALLOWED_EMAILS="${ADDITIONAL_ALLOWED_EMAILS:-}"

DOMAIN="hello-wnw.org"
API_HOST="api.${DOMAIN}"
OWNER_EMAIL="hello.awholenewworld@gmail.com"

cf() {
  curl -sS -X "$1" "https://api.cloudflare.com/client/v4/$2" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    ${3:+-d "$3"}
}

echo "== Looking up zone for ${DOMAIN} =="
ZONE_ID=$(cf GET "zones?name=${DOMAIN}" | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')
if [[ -z "$ZONE_ID" ]]; then
  echo "No zone found for ${DOMAIN} in this Cloudflare account."
  echo "Add the site in the Cloudflare dashboard first (Websites > Add a Site), then"
  echo "point ${DOMAIN}'s nameservers at Cloudflare with your current registrar, and re-run."
  exit 1
fi
echo "Zone: ${ZONE_ID}"

echo "== Upserting A record for ${API_HOST} -> ${WSERVER_PUBLIC_IP} (proxied) =="
EXISTING_RECORD_ID=$(cf GET "zones/${ZONE_ID}/dns_records?type=A&name=${API_HOST}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')

# The comment field is the "memo" you asked for. Note: DNS record comments
# are visible to anyone with DNS-read access on this zone via the dashboard
# or API — treat it as a personal note field on your own account, not a
# secrets vault, but it's your call for a single-tenant personal project.
RECORD_PAYLOAD=$(python3 - "$API_HOST" "$WSERVER_PUBLIC_IP" "$DVD_API_KEY" <<'PY'
import json, sys
name, ip, key = sys.argv[1:4]
print(json.dumps({
    "type": "A",
    "name": name,
    "content": ip,
    "proxied": True,
    "comment": f"DvD backend API key: {key}",
}))
PY
)

if [[ -n "$EXISTING_RECORD_ID" ]]; then
  cf PUT "zones/${ZONE_ID}/dns_records/${EXISTING_RECORD_ID}" "$RECORD_PAYLOAD" >/dev/null
else
  cf POST "zones/${ZONE_ID}/dns_records" "$RECORD_PAYLOAD" >/dev/null
fi
echo "DNS record set, API key noted in its comment."

echo "== Configuring Cloudflare Access (free tier, up to 50 users) =="
build_policy_include() {
  python3 - "$OWNER_EMAIL" "$ADDITIONAL_ALLOWED_EMAILS" <<'PY'
import json, sys
owner, extra = sys.argv[1], sys.argv[2]
emails = [owner] + [e.strip() for e in extra.split(",") if e.strip()]
print(json.dumps([{"email": {"email": e}} for e in emails]))
PY
}
POLICY_INCLUDE=$(build_policy_include)

create_access_app() {
  local app_domain="$1" app_name="$2"
  local app_payload
  app_payload=$(python3 - "$app_domain" "$app_name" <<'PY'
import json, sys
domain, name = sys.argv[1], sys.argv[2]
print(json.dumps({
    "name": name,
    "domain": domain,
    "type": "self_hosted",
    "session_duration": "24h",
}))
PY
)
  local app_id
  app_id=$(cf POST "accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps" "$app_payload" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["id"])')

  local policy_payload
  policy_payload=$(python3 - "$POLICY_INCLUDE" <<'PY'
import json, sys
include = json.loads(sys.argv[1])
print(json.dumps({"name": "Allowed users", "decision": "allow", "include": include}))
PY
)
  cf POST "accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${app_id}/policies" "$policy_payload" >/dev/null
  echo "Access app for ${app_domain}: ${app_id}"
}

create_access_app "$DOMAIN" "DvD site"
create_access_app "$API_HOST" "DvD API"

echo "Done. To widen the allowlist later, set ADDITIONAL_ALLOWED_EMAILS and re-run —"
echo "this script re-creates the policy's include list each time rather than appending."
