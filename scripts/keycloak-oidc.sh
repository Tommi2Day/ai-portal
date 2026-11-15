#!/usr/bin/env bash
# Maintain groups and OIDC applications (clients) of the Keycloak realm from docker-compose.support.yaml.
#
#   scripts/keycloak-oidc.sh group list
#   scripts/keycloak-oidc.sh group add <name>
#   scripts/keycloak-oidc.sh group delete <name> [--force]
#   scripts/keycloak-oidc.sh group members <name>
#   scripts/keycloak-oidc.sh group join <name> <username>
#   scripts/keycloak-oidc.sh group leave <name> <username>
#
#   scripts/keycloak-oidc.sh app list [--all]
#   scripts/keycloak-oidc.sh app show <clientId>
#   scripts/keycloak-oidc.sh app add <clientId> [--name "Display name"] [--redirect <uri>]... [--public]
#                                    [--service-account [--sa-group <group>]] [--audience <aud>] [--no-groups-claim]
#   scripts/keycloak-oidc.sh app redirects <clientId> <uri>...      replace all redirect URIs
#   scripts/keycloak-oidc.sh app secret <clientId> [--force]        generate a new client secret
#   scripts/keycloak-oidc.sh app delete <clientId> [--force]
#
# Groups end up in the "groups" claim of the tokens (the portal reads them for OIDC_ADMIN_GROUPS / OIDC_ALLOWED_GROUPS and
# the group-based access of knowledge collections). ai-portal-admins / ai-portal-users are the groups of the portal.
#
# app add creates an application with authorization code flow + PKCE (S256), no password grant, and prints the generated
# client secret once:
#   --redirect URI      allowed redirect URI (repeatable; web origins are derived from them)
#   --public            public client without secret (single-page or native apps, PKCE only)
#   --service-account   client credentials grant for services (e.g. an MCP server the portal calls with OAuth);
#                       --sa-group puts its service account into a group so that the token carries it
#   --audience AUD      adds an audience mapper (aud claim), e.g. api://my-mcp
#   --no-groups-claim   do not add the groups claim mapper
# The built-in clients and the portal client ai-portal are protected: changes need --force.
#
# Users: scripts/keycloak-user.sh. Settings (KEYCLOAK_HOST, KEYCLOAK_ADMIN_PASSWORD, KEYCLOAK_CACERT, CURL_OPTS, ...):
# see scripts/keycloak-lib.sh.
set -euo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"   # the library changes into the repository root
# shellcheck source=keycloak-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/keycloak-lib.sh"

PROTECTED_GROUPS=" ai-portal-admins ai-portal-users "
BUILTIN_CLIENTS=" account account-console admin-cli broker realm-management security-admin-console "

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF" >&2; exit 2; }
json_bool() { [ "$1" = true ] && echo true || echo false; }
first_id() { sed -n 's/^{"id":"\([^"]*\)".*/\1/p'; }   # id of a single JSON object
names() { grep -o '"name":"[^"]*"' | sed 's/"name":"\(.*\)"/\1/' | sort -u; }

# --- groups -------------------------------------------------------------------------------------------------
need_group() { # name -> id (dies if missing)
  valid_group "$1"
  local id; id="$(group_id "$1")"
  [ -n "$id" ] || die "group '$1' not found"
  printf '%s' "$id"
}
need_user() {
  valid_username "$1"
  local id; id="$(user_id "$1")"
  [ -n "$id" ] || die "user '$1' not found"
  printf '%s' "$id"
}

cmd_group() {
  local sub="${1:-}"; [ $# -eq 0 ] || shift
  case "$sub" in
    list)
      [ $# -eq 0 ] || usage
      get_token; api GET "/groups?max=500"; must 200
      body | grep -o '"name":"[^"]*","path":"/[^/"]*"' | sed 's/"name":"\([^"]*\)".*/\1/' | sort -u ;;
    add)
      [ $# -eq 1 ] || usage
      valid_group "$1"; get_token
      api POST "/groups" - <<< "$(printf '{"name":"%s"}' "$1")"
      [ "$STATUS" != 409 ] || die "group '$1' already exists"
      must 201
      echo "group '$1' created" ;;
    delete)
      [ $# -ge 1 ] && [ $# -le 2 ] || usage
      local name="$1" force="${2:-}"
      [ -z "$force" ] || [ "$force" = --force ] || usage
      valid_group "$name"
      if [[ "$PROTECTED_GROUPS" == *" $name "* && "$force" != --force ]]; then
        die "'$name' is a group of the portal; deleting it needs --force"
      fi
      get_token
      local gid; gid="$(need_group "$name")"
      api DELETE "/groups/$gid"; must 204
      echo "group '$name' deleted" ;;
    members)
      [ $# -eq 1 ] || usage
      get_token
      local gid; gid="$(need_group "$1")"
      api GET "/groups/$gid/members?max=500"; must 200
      body | grep -o '"username":"[^"]*"' | sed 's/"username":"\(.*\)"/\1/' | sort ;;
    join | leave)
      [ $# -eq 2 ] || usage
      get_token
      local gid uid; gid="$(need_group "$1")"; uid="$(need_user "$2")"
      if [ "$sub" = join ]; then
        api PUT "/users/$uid/groups/$gid"; must 204
        echo "user '$2' joined group '$1'"
      else
        api DELETE "/users/$uid/groups/$gid"; must 204
        echo "user '$2' left group '$1'"
      fi ;;
    *) usage ;;
  esac
}

# --- applications -------------------------------------------------------------------------------------------
origin_of() { printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1#'; }
json_array() { # items... -> ["a","b"]
  local out="" i
  for i in "$@"; do out+="\"$i\","; done
  printf '[%s]' "${out%,}"
}
guard_client() { # clientId force
  case "$BUILTIN_CLIENTS" in *" $1 "*) die "'$1' is a built-in Keycloak client" ;; esac
  [ "$1" != ai-portal ] || [ "${2:-}" = --force ] || die "'ai-portal' is the portal's own client; changing it needs --force (and the same change in .env)"
}
need_client() {
  valid_client "$1"
  local id; id="$(client_uuid "$1")"
  [ -n "$id" ] || die "client '$1' not found"
  printf '%s' "$id"
}

app_add() {
  local clientid="${1:-}"; [ -n "$clientid" ] || usage
  shift
  local name="" public=false sa=false sagroup="" audience="" groups_claim=true redirects=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) shift; [ $# -gt 0 ] || usage; valid_text "$1"; name="$1" ;;
      --redirect) shift; [ $# -gt 0 ] || usage; valid_uri "$1"; redirects+=("$1") ;;
      --public) public=true ;;
      --service-account) sa=true ;;
      --sa-group) shift; [ $# -gt 0 ] || usage; valid_group "$1"; sagroup="$1" ;;
      --audience) shift; [ $# -gt 0 ] || usage; valid_client "$1"; audience="$1" ;;
      --no-groups-claim) groups_claim=false ;;
      *) usage ;;
    esac
    shift
  done
  valid_client "$clientid"
  guard_client "$clientid"
  [ "$public" = false ] || [ "$sa" = false ] || die "--public and --service-account exclude each other (a service needs a secret)"
  [ -z "$sagroup" ] || [ "$sa" = true ] || die "--sa-group needs --service-account"
  [ "${#redirects[@]}" -gt 0 ] || [ "$sa" = true ] || die "give at least one --redirect, or --service-account"
  [ -n "$name" ] || name="$clientid"

  get_token
  local existing; existing="$(client_uuid "$clientid")"
  [ -z "$existing" ] || die "client '$clientid' already exists"
  local gid=""
  [ -z "$sagroup" ] || gid="$(need_group "$sagroup")"

  local origins=() r o seen=" "
  for r in ${redirects[@]+"${redirects[@]}"}; do
    o="$(origin_of "$r")"
    case "$seen" in *" $o "*) ;; *) origins+=("$o"); seen+="$o " ;; esac
  done
  local secret="" secret_json=""
  if [ "$public" = false ]; then secret="$(genpass 32)"; secret_json=",\"secret\":\"$secret\""; fi
  local mappers=""
  if [ "$groups_claim" = true ]; then
    mappers='{"name":"groups","protocol":"openid-connect","protocolMapper":"oidc-group-membership-mapper","consentRequired":false,"config":{"claim.name":"groups","full.path":"false","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true"}}'
  fi
  if [ -n "$audience" ]; then
    [ -z "$mappers" ] || mappers+=","
    mappers+="{\"name\":\"audience\",\"protocol\":\"openid-connect\",\"protocolMapper\":\"oidc-audience-mapper\",\"consentRequired\":false,\"config\":{\"included.custom.audience\":\"$audience\",\"id.token.claim\":\"false\",\"access.token.claim\":\"true\"}}"
  fi

  api POST "/clients" - <<< "$(printf '{"clientId":"%s","name":"%s","enabled":true,"protocol":"openid-connect","publicClient":%s,"standardFlowEnabled":%s,"implicitFlowEnabled":false,"directAccessGrantsEnabled":false,"serviceAccountsEnabled":%s,"redirectUris":%s,"webOrigins":%s,"attributes":{"pkce.code.challenge.method":"S256"}%s,"protocolMappers":[%s]}' \
    "$clientid" "$name" "$public" "$([ "${#redirects[@]}" -gt 0 ] && echo true || echo false)" "$sa" \
    "$(json_array ${redirects[@]+"${redirects[@]}"})" "$(json_array ${origins[@]+"${origins[@]}"})" "$secret_json" "$mappers")"
  must 201
  local cid; cid="$(sed -n 's/^[Ll]ocation: .*\/clients\/\([^[:space:]]*\).*/\1/p' "$TMP/resp" | tr -d '\r')"
  [ -n "$cid" ] || die "client created but its id is unknown"

  if [ -n "$gid" ]; then
    api GET "/clients/$cid/service-account-user"; must 200
    local sid; sid="$(body | first_id)"
    [ -n "$sid" ] || die "service account user of '$clientid' not found"
    api PUT "/users/$sid/groups/$gid"; must 204
  fi

  echo "client:     $clientid ($([ "$public" = true ] && echo public || echo confidential)$([ "$sa" = true ] && echo ', service account'))"
  [ -z "$secret" ] || echo "secret:     $secret   (shown once)"
  [ "${#redirects[@]}" -eq 0 ] || echo "redirects:  ${redirects[*]}"
  [ -z "$sagroup" ] || echo "group:      $sagroup (service account)"
  echo "issuer:     $KC_URL/realms/$REALM"
  echo "discovery:  $KC_URL/realms/$REALM/.well-known/openid-configuration"
}

app_show() {
  [ $# -eq 1 ] || usage
  get_token
  local cid; cid="$(need_client "$1")"
  api GET "/clients/$cid"; must 200
  local b; b="$(body)"
  field() { printf '%s' "$b" | grep -o "\"$1\":[a-z]*" | head -n1 | cut -d: -f2; }
  echo "client:           $1"
  echo "name:             $(printf '%s' "$b" | sed -n 's/^{"id":"[^"]*","clientId":"[^"]*","name":"\([^"]*\)".*/\1/p')"
  echo "enabled:          $(field enabled)"
  echo "public:           $(field publicClient)"
  echo "code flow:        $(field standardFlowEnabled)"
  echo "service account:  $(field serviceAccountsEnabled)"
  echo "redirect URIs:    $(printf '%s' "$b" | sed -n 's/.*"redirectUris":\[\([^]]*\)\].*/\1/p' | tr -d '"')"
}

app_redirects() {
  [ $# -ge 2 ] || usage
  local clientid="$1"; shift
  local u; for u in "$@"; do valid_uri "$u"; done
  guard_client "$clientid"
  get_token
  local cid; cid="$(need_client "$clientid")"
  local origins=() o seen=" "
  for u in "$@"; do
    o="$(origin_of "$u")"
    case "$seen" in *" $o "*) ;; *) origins+=("$o"); seen+="$o " ;; esac
  done
  # partial update: only these two fields change
  api PUT "/clients/$cid" - <<< "$(printf '{"id":"%s","clientId":"%s","redirectUris":%s,"webOrigins":%s}' \
    "$cid" "$clientid" "$(json_array "$@")" "$(json_array "${origins[@]}")")"
  must 204
  echo "redirect URIs of '$clientid': $*"
}

app_secret() {
  [ $# -ge 1 ] && [ $# -le 2 ] || usage
  local clientid="$1" force="${2:-}"
  [ -z "$force" ] || [ "$force" = --force ] || usage
  guard_client "$clientid" "$force"
  get_token
  local cid; cid="$(need_client "$clientid")"
  api GET "/clients/$cid"; must 200
  if body | grep -q '"publicClient":true'; then die "'$clientid' is a public client and has no secret"; fi
  api POST "/clients/$cid/client-secret"; must 200
  local s; s="$(body | sed -n 's/.*"value":"\([^"]*\)".*/\1/p')"
  [ -n "$s" ] || die "no secret returned"
  echo "client:  $clientid"
  echo "secret:  $s   (shown once; the old secret no longer works)"
}

app_delete() {
  [ $# -ge 1 ] && [ $# -le 2 ] || usage
  local clientid="$1" force="${2:-}"
  [ -z "$force" ] || [ "$force" = --force ] || usage
  guard_client "$clientid" "$force"
  get_token
  local cid; cid="$(need_client "$clientid")"
  api DELETE "/clients/$cid"; must 204
  echo "client '$clientid' deleted"
}

app_list() {
  local all=false
  [ "${1:-}" != --all ] || { all=true; shift; }
  [ $# -eq 0 ] || usage
  get_token
  api GET "/clients?max=500"; must 200
  local id
  body | grep -o '"clientId":"[^"]*"' | sed 's/"clientId":"\(.*\)"/\1/' | sort | while read -r id; do
    if [ "$all" = true ] || [[ "$BUILTIN_CLIENTS" != *" $id "* ]]; then echo "$id"; fi
  done
}

cmd_app() {
  local sub="${1:-}"; [ $# -eq 0 ] || shift
  case "$sub" in
    list) app_list "$@" ;;
    show) app_show "$@" ;;
    add) app_add "$@" ;;
    redirects) app_redirects "$@" ;;
    secret) app_secret "$@" ;;
    delete) app_delete "$@" ;;
    *) usage ;;
  esac
}

case "${1:-}" in
  group) shift; cmd_group "$@" ;;
  app) shift; cmd_app "$@" ;;
  *) usage ;;
esac
