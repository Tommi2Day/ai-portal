#!/usr/bin/env bash
# Shared helpers of scripts/keycloak-user.sh and scripts/keycloak-oidc.sh (source it, do not run it):
# Keycloak admin REST API access for the realm of docker-compose.support.yaml.
#
# Settings come from the environment, then from .env (never from the command line, so nothing shows up in `ps`):
#   KEYCLOAK_HOST            default auth.localhost       (or KEYCLOAK_URL, e.g. https://auth.example.com)
#   KEYCLOAK_ADMIN_PASSWORD  asked for if missing         (admin user: KEYCLOAK_ADMIN_USER, default admin)
#   KEYCLOAK_REALM           default ai-portal
#   KEYCLOAK_CACERT          CA file for an internal CA   (default: OIDC_CA_FILE inside TRAEFIK_CERTS_DIR / ./certs)
#   CURL_OPTS                extra curl options, e.g. "--resolve auth.example.com:443:10.0.0.5"
#   ENV_FILE                 default .env
# Needs bash, curl and openssl. Generated passwords are printed once and stored nowhere.
# Needs bash, curl and openssl. Generated secrets are printed once and stored nowhere.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE="${ENV_FILE:-.env}"
die() { echo "error: $*" >&2; exit 1; }

# value of KEY from the env file (last assignment, surrounding quotes removed); empty if absent
envval() {
  [ -r "$ENV_FILE" ] || return 0
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}
setting() { # NAME DEFAULT: environment, then .env, then default
  local v="${!1:-}"
  [ -n "$v" ] || v="$(envval "$1")"
  printf '%s' "${v:-$2}"
}

KEYCLOAK_HOST="$(setting KEYCLOAK_HOST auth.localhost)"
KC_URL="${KEYCLOAK_URL:-https://$KEYCLOAK_HOST}"
REALM="$(setting KEYCLOAK_REALM ai-portal)"
ADMIN_USER="$(setting KEYCLOAK_ADMIN_USER admin)"
CLIENT_ID=ai-portal
CACERT="${KEYCLOAK_CACERT:-}"
if [ -z "$CACERT" ] && [ -n "$(envval OIDC_CA_FILE)" ]; then
  CACERT="$(setting TRAEFIK_CERTS_DIR ./certs)/$(basename "$(envval OIDC_CA_FILE)")"
fi

CURL=(curl -sS)
[ -z "$CACERT" ] || CURL+=(--cacert "$CACERT")
read -r -a EXTRA <<< "${CURL_OPTS:-}"
CURL+=(${EXTRA[@]+"${EXTRA[@]}"})

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

urlenc() {
  local LC_ALL=C s="$1" i c out=
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in [a-zA-Z0-9.~_-]) out+="$c" ;; *) out+="$(printf '%%%02X' "'$c")" ;; esac
  done
  printf '%s' "$out"
}

genpass() { # [LENGTH, default 20]: random letters and digits
  local n="${1:-20}" p
  p="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$n" || true)"
  [ "${#p}" -eq "$n" ] || die "could not generate a random value"
  printf '%s' "$p"
}

# --- admin API ----------------------------------------------------------------------------------------------
get_token() {
  local pw
  pw="$(setting KEYCLOAK_ADMIN_PASSWORD '')"
  if [ -z "$pw" ]; then
    [ -t 0 ] || die "KEYCLOAK_ADMIN_PASSWORD is not set (environment or $ENV_FILE)"
    read -r -s -p "Keycloak admin password ($ADMIN_USER): " pw
    echo >&2
  fi
  local out
  out="$(printf 'client_id=admin-cli&grant_type=password&username=%s&password=%s' "$(urlenc "$ADMIN_USER")" "$(urlenc "$pw")" |
    "${CURL[@]}" -d @- "$KC_URL/realms/master/protocol/openid-connect/token")" || die "cannot reach $KC_URL"
  TOKEN="$(printf '%s' "$out" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
  [ -n "$TOKEN" ] || die "admin login failed (wrong KEYCLOAK_ADMIN_PASSWORD or admin user?)"
  # the token goes through a header file, not through the command line
  printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$TOKEN" > "$TMP/headers"
  chmod 600 "$TMP/headers"
}

# api METHOD PATH [-]   a trailing "-" sends stdin as the JSON body; sets STATUS, body in $TMP/body, headers in $TMP/resp
api() {
  local method="$1" path="$2" data=()
  [ "${3:-}" = "-" ] && data=(--data-binary @-)
  STATUS="$("${CURL[@]}" -X "$method" -H "@$TMP/headers" ${data[@]+"${data[@]}"} -D "$TMP/resp" -o "$TMP/body" \
    -w '%{http_code}' "$KC_URL/admin/realms/$REALM$path")" || die "request to $KC_URL failed"
}
body() { cat "$TMP/body"; }
must() { # EXPECTED_STATUS... : fail with the server's message otherwise
  local s
  for s in "$@"; do [ "$STATUS" = "$s" ] && return 0; done
  die "Keycloak answered HTTP $STATUS: $(body | head -c 300)"
}

user_id() { # exact username -> id (empty if none)
  api GET "/users?username=$(urlenc "$1")&exact=true"
  must 200
  body | sed -n 's/^\[{"id":"\([^"]*\)".*/\1/p'
}
group_id() {
  api GET "/groups?search=$(urlenc "$1")&exact=true"
  must 200
  body | sed -n 's/^\[{"id":"\([^"]*\)".*/\1/p'
}

valid_username() { [[ "$1" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || die "invalid username (allowed: letters, digits . _ @ -, max 64)"; }
valid_text() { [[ "$1" != *\"* && "$1" != *\\* && "$1" != *$'\n'* ]] || die "quotes, backslashes and line breaks are not allowed in names"; }

set_password() { # id password temporary(true|false)
  # here-string, not a pipe: api must run in this shell to set STATUS
  api PUT "/users/$1/reset-password" - <<< "$(printf '{"type":"password","value":"%s","temporary":%s}' "$2" "$3")"
  must 204
}

valid_group() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "invalid group name (allowed: letters, digits . _ -, max 64)"; }
valid_client() { [[ "$1" =~ ^[A-Za-z0-9._:/@-]{1,100}$ ]] || die "invalid client id (allowed: letters, digits . _ : / @ -, max 100)"; }
valid_uri() {
  # no spaces, quotes or backslashes: the value goes into JSON as is
  [[ "$1" =~ ^https?://[^[:space:]\"\]+$ ]] || die "invalid redirect URI '$1' (http(s)://..., no spaces, quotes or backslashes)"
}
client_uuid() { # exact clientId -> internal id (empty if none)
  api GET "/clients?clientId=$(urlenc "$1")"
  must 200
  body | sed -n 's/^\[{"id":"\([^"]*\)".*/\1/p'
}
