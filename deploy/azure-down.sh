#!/usr/bin/env bash
#
# Delete everything ./deploy/azure.sh created, so the plan stops
# billing against your credits.

set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-caving-with-friends-rg}"

echo "This deletes the resource group '$RESOURCE_GROUP' and everything in it."
read -r -p "Type the group name to confirm: " reply

if [ "$reply" != "$RESOURCE_GROUP" ]; then
    echo "Not confirmed. Nothing deleted."
    exit 1
fi

az group delete --name "$RESOURCE_GROUP" --yes
echo "Deleted."
