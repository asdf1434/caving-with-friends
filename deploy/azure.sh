#!/usr/bin/env bash
#
# Deploy Caving With Friends to Azure App Service.
#
# Run it from the project root:
#
#     ./deploy/azure.sh
#
# The first run creates everything and takes a few minutes.
# Later runs only upload the code, which takes under a minute.
#
# Requires the Azure CLI and a completed `az login`.

set -euo pipefail

# The app name has to be unique across all of Azure, because it
# becomes <APP_NAME>.azurewebsites.net. Change it if the name is
# taken; the script will tell you.
APP_NAME="${APP_NAME:-caving-with-friends}"

RESOURCE_GROUP="${RESOURCE_GROUP:-caving-with-friends-rg}"
PLAN_NAME="${PLAN_NAME:-caving-with-friends-plan}"
LOCATION="${LOCATION:-westus2}"

# B1 is the cheapest tier that supports WebSockets and Always On.
# The free F1 tier does not, so the game cannot run on it.
SKU="${SKU:-B1}"

RUNTIME="${RUNTIME:-NODE:22-lts}"


echo "==> Resource group: $RESOURCE_GROUP ($LOCATION)"
az group create \
    --name "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --output none

echo "==> App Service plan: $PLAN_NAME ($SKU, Linux)"
az appservice plan create \
    --name "$PLAN_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku "$SKU" \
    --is-linux \
    --output none

echo "==> Web app: $APP_NAME"
if ! az webapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --output none 2>/dev/null; then
    az webapp create \
        --name "$APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --plan "$PLAN_NAME" \
        --runtime "$RUNTIME" \
        --output none
fi

echo "==> Settings"
#
#   web-sockets-enabled  the whole point; off by default
#   always-on            keeps the process from being unloaded
#                        while idle, so the first visitor after
#                        a quiet hour does not wait for a start
#   startup-file         App Service would otherwise guess
#   http20-enabled       false, because WebSockets need HTTP/1.1
#
az webapp config set \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --web-sockets-enabled true \
    --always-on true \
    --http20-enabled false \
    --startup-file "node server/server.js" \
    --output none

# Rooms live in the process memory of one instance, so the app
# must never scale past a single copy of itself. Two instances
# would put players who typed the same room code into two
# different rooms.
az appservice plan update \
    --name "$PLAN_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --number-of-workers 1 \
    --output none

# Only reachable over HTTPS, so the page always loads over TLS
# and the client picks wss:// for the socket.
az webapp update \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --https-only true \
    --output none

# Build on the server, so node_modules is installed there for
# the right platform rather than uploaded from a Mac.
az webapp config appsettings set \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true \
    --output none

echo "==> Health probe"
az webapp config set \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --generic-configurations '{"healthCheckPath": "/health"}' \
    --output none

echo "==> Packaging"
#
# public/ is included because server.js imports the shared
# engine from it. public/data is not: the word lists are served
# by GitHub Pages now, and the server never reads them.
#
ZIP="$(mktemp -d)/app.zip"
zip -qr "$ZIP" \
    package.json package-lock.json server public \
    -x '*.DS_Store' 'public/data/*'

echo "==> Uploading $(du -h "$ZIP" | cut -f1)"
az webapp deploy \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --src-path "$ZIP" \
    --type zip \
    --output none

rm -f "$ZIP"

URL="https://${APP_NAME}.azurewebsites.net"

echo
echo "Deployed:  $URL"
echo "Health:    $URL/health"
echo
echo "Logs:      az webapp log tail --name $APP_NAME --resource-group $RESOURCE_GROUP"
