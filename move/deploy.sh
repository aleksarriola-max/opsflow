#!/usr/bin/env bash
# Deploy the ops_agent package to Sui testnet and print the env vars the
# backend needs. Requires the Sui CLI with an active funded testnet address:
#   https://docs.sui.io/guides/developer/getting-started/sui-install
#   sui client faucet
set -euo pipefail
cd "$(dirname "$0")"

echo "Building..."
sui move build

echo "Publishing to $(sui client active-env)..."
OUTPUT=$(sui client publish --gas-budget 200000000 --json)

PACKAGE_ID=$(echo "$OUTPUT" | jq -r '.objectChanges[] | select(.type=="published") | .packageId')
echo
echo "Published. Add to backend/.env:"
echo "  SUI_MODE=testnet"
echo "  SUI_PACKAGE_ID=$PACKAGE_ID"
echo "  SUI_SECRET_KEY=<your suiprivkey...>   # sui keytool export"
echo
echo "Then create the org + policy + buckets (shared objects) and record their IDs:"
echo "  sui client call --package $PACKAGE_ID --module org --function create_org_entry --args '\"My Org\"' --gas-budget 10000000"
