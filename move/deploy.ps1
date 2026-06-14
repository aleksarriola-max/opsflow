# Windows deploy script for the ops_agent Move package (PowerShell).
# One-time setup (10 min):
#   1. Download sui-testnet-vX.Y.Z-windows-x86_64.tgz from
#      https://github.com/MystenLabs/sui/releases (latest testnet release)
#   2. Extract and put sui.exe somewhere on your PATH
#   3. sui client                       # first run: accept defaults -> testnet, new keypair
#   4. sui client faucet                # free testnet SUI for gas
# Then run this script from the move/ directory:  .\deploy.ps1

$ErrorActionPreference = "Stop"

Write-Host "Active env: $(sui client active-env)"
Write-Host "Address:    $(sui client active-address)"

Write-Host "`nBuilding..."
sui move build

Write-Host "`nPublishing (gas budget 200000000)..."
$out = sui client publish --gas-budget 200000000 --json | ConvertFrom-Json
$pkg = ($out.objectChanges | Where-Object { $_.type -eq "published" }).packageId

Write-Host "`n=============================================="
Write-Host "Published package: $pkg"
Write-Host "Add to backend/.env:"
Write-Host "  SUI_MODE=testnet"
Write-Host "  SUI_PACKAGE_ID=$pkg"
Write-Host "  SUI_SECRET_KEY=<run: sui keytool export --key-identity (sui client active-address)>"
Write-Host "=============================================="
Write-Host "`nNext: create the org (sender becomes admin, gets AdminCap):"
Write-Host "  sui client call --package $pkg --module org --function create_org_entry --args '\"OpsFlow Demo Org\"' --gas-budget 10000000"
Write-Host "Record the shared Org object ID as SUI_ORG_ID, then create PolicySet"
Write-Host "and BudgetBuckets via policy::create_policy_set / create_budget_bucket."
