#!/usr/bin/env bash
# Signs Windows files in place with Azure Artifact Signing, through jsign
# (https://github.com/ebourg/jsign), which runs on Linux and macOS.
#
#   tools/sign-windows.sh <file.exe>...
#
# Needs: java, the Azure CLI signed in to an identity with the "Artifact
# Signing Certificate Profile Signer" role, and
#   JSIGN_JAR                  the jsign jar
#   ARTIFACT_SIGNING_ENDPOINT  for example https://eus.codesigning.azure.net
#   ARTIFACT_SIGNING_ACCOUNT   the signing account
#   ARTIFACT_SIGNING_PROFILE   its certificate profile
# Each call gets a fresh access token (they last about an hour). Signatures
# are SHA-256 with an RFC 3161 timestamp from Microsoft's timestamp server.
set -euo pipefail

: "${JSIGN_JAR:?}" "${ARTIFACT_SIGNING_ENDPOINT:?}" "${ARTIFACT_SIGNING_ACCOUNT:?}" "${ARTIFACT_SIGNING_PROFILE:?}"
[ $# -gt 0 ] || { echo "usage: $0 <file.exe>..." >&2; exit 2; }

host="${ARTIFACT_SIGNING_ENDPOINT#https://}"
host="${host%%/*}"
token=$(az account get-access-token --resource https://codesigning.azure.net --query accessToken -o tsv)
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::$token"
fi

java -jar "$JSIGN_JAR" \
  --storetype TRUSTEDSIGNING \
  --keystore "$host" \
  --storepass "$token" \
  --alias "$ARTIFACT_SIGNING_ACCOUNT/$ARTIFACT_SIGNING_PROFILE" \
  --alg SHA-256 \
  --tsaurl http://timestamp.acs.microsoft.com \
  --tsmode RFC3161 \
  --replace \
  "$@"
