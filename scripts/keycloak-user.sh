#!/usr/bin/env bash
# Manage users of the Keycloak realm from docker-compose.support.yaml (realm "ai-portal") through the admin REST API.
#
#   scripts/keycloak-user.sh add <username> <email> --name "First Last" [--admin] [--permanent]
#   scripts/keycloak-user.sh passwd <username> [--permanent]
#   scripts/keycloak-user.sh delete <username>
#   scripts/keycloak-user.sh list
#   scripts/keycloak-user.sh secret            set the client secret of "ai-portal" to OIDC_CLIENT_SECRET from .env
#
# add     creates the user, puts it into the group ai-portal-users (--admin: ai-portal-admins = portal admins) and
#         prints a generated one-time password; the user must change it at the first login unless --permanent is given.
# passwd  sets a new generated password.
# secret  needed after changing OIDC_CLIENT_SECRET in .env, because the realm import only runs once.
#
# Settings (KEYCLOAK_HOST, KEYCLOAK_ADMIN_PASSWORD, KEYCLOAK_CACERT, CURL_OPTS, ...): see scripts/keycloak-lib.sh.
# Groups and OIDC applications: scripts/keycloak-oidc.sh.
set -euo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"   # the library changes into the repository root
# shellcheck source=keycloak-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/keycloak-lib.sh"

# --- commands -----------------------------------------------------------------------------------------------
cmd_add() {
  local username="${1:-}" email="${2:-}"
  [ -n "$username" ] && [ -n "$email" ] || usage
  shift 2
  local admin=false permanent=false first="" last=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --admin) admin=true ;;
      --permanent) permanent=true ;;
      --name) shift; [ $# -gt 0 ] || usage; valid_text "$1"; first="${1%% *}"; [ "$1" = "$first" ] && last="" || last="${1#* }" ;;
      *) usage ;;
    esac
    shift
  done
  valid_username "$username"
  # Keycloak's default user profile requires both names; without them every first login is held up by a "verify profile" step
  [ -n "$first" ] && [ -n "$last" ] || die "--name \"First Last\" is required (first and last name)"
  [[ "$email" =~ ^[^@\ \"\\]+@[^@\ \"\\]+$ ]] || die "invalid e-mail address"
  get_token
  local existing; existing="$(user_id "$username")"   # assigned first so that a failed lookup aborts the script
  [ -z "$existing" ] || die "user '$username' already exists (use: passwd $username)"
  local group=ai-portal-users
  [ "$admin" = false ] || group=ai-portal-admins
  local gid; gid="$(group_id "$group")"
  [ -n "$gid" ] || die "group '$group' not found in realm '$REALM' (was the realm imported?)"

  api POST "/users" - <<< "$(printf '{"username":"%s","email":"%s","emailVerified":true,"enabled":true,"firstName":"%s","lastName":"%s"}' \
    "$username" "$email" "$first" "$last")"
  must 201
  local uid; uid="$(sed -n 's/^[Ll]ocation: .*\/users\/\([^[:space:]]*\).*/\1/p' "$TMP/resp" | tr -d '\r')"
  [ -n "$uid" ] || die "user created but its id is unknown"
  api PUT "/users/$uid/groups/$gid"
  must 204
  local pw; pw="$(genpass)"
  set_password "$uid" "$pw" "$([ "$permanent" = true ] && echo false || echo true)"

  echo "user:      $username <$email>"
  echo "group:     $group$([ "$admin" = true ] && echo ' (portal admin)')"
  echo "password:  $pw$([ "$permanent" = true ] || echo '   (one-time, must be changed at the first login)')"
  echo "sign in:   $(setting PUBLIC_URL "https://$(setting PORTAL_HOST ai.localhost)")"
}

cmd_passwd() {
  local username="${1:-}"; [ -n "$username" ] || usage
  shift
  local permanent=false
  [ "${1:-}" != "--permanent" ] || { permanent=true; shift; }
  [ $# -eq 0 ] || usage
  valid_username "$username"
  get_token
  local uid; uid="$(user_id "$username")"
  [ -n "$uid" ] || die "user '$username' not found"
  local pw; pw="$(genpass)"
  set_password "$uid" "$pw" "$([ "$permanent" = true ] && echo false || echo true)"
  echo "user:      $username"
  echo "password:  $pw$([ "$permanent" = true ] || echo '   (one-time, must be changed at the next login)')"
}

cmd_delete() {
  local username="${1:-}"
  [ -n "$username" ] && [ $# -eq 1 ] || usage
  valid_username "$username"
  get_token
  local uid; uid="$(user_id "$username")"
  [ -n "$uid" ] || die "user '$username' not found"
  api DELETE "/users/$uid"
  must 204
  echo "user '$username' deleted"
}

cmd_list() {
  get_token
  api GET "/users?max=500"
  must 200
  body | grep -o '"username":"[^"]*"' | sed 's/"username":"\(.*\)"/\1/' | sort
}

cmd_secret() {
  local secret; secret="$(envval OIDC_CLIENT_SECRET)"
  [ -n "${OIDC_CLIENT_SECRET:-}" ] && secret="$OIDC_CLIENT_SECRET"
  [ -n "$secret" ] || die "OIDC_CLIENT_SECRET is not set (environment or $ENV_FILE)"
  [[ "$secret" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || die "OIDC_CLIENT_SECRET may only contain letters, digits and . _ ~ + / = - (use openssl rand -hex 32)"
  get_token
  api GET "/clients?clientId=$CLIENT_ID"
  must 200
  local cid; cid="$(body | sed -n 's/^\[{"id":"\([^"]*\)".*/\1/p')"
  [ -n "$cid" ] || die "client '$CLIENT_ID' not found in realm '$REALM'"
  api PUT "/clients/$cid" - <<< "$(printf '{"id":"%s","clientId":"%s","secret":"%s"}' "$cid" "$CLIENT_ID" "$secret")"
  must 204
  api GET "/clients/$cid/client-secret"
  must 200
  body | grep -q "\"value\":\"$secret\"" || die "the client secret was not updated"
  echo "client secret of '$CLIENT_ID' set to OIDC_CLIENT_SECRET"
}

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF" >&2; exit 2; }

case "${1:-}" in
  add) shift; cmd_add "$@" ;;
  passwd) shift; cmd_passwd "$@" ;;
  delete) shift; cmd_delete "$@" ;;
  list) cmd_list ;;
  secret) cmd_secret ;;
  *) usage ;;
esac
