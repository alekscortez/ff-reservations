#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

FUNCTION_NAME="${FUNCTION_NAME:-ff-reservations-api}"
AWS_REGION="${AWS_REGION:-us-east-1}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-15}"
MEMORY_SIZE_MB="${MEMORY_SIZE_MB:-256}"
ZIP_PATH="function.zip"

rm -f "$ZIP_PATH"

# Install runtime-only dependencies (passkit-generator + its tree) into a
# local node_modules. The AWS Lambda Node 22 runtime ships @aws-sdk/* so we
# never list those here — see backend/lambda/package.json. The install is
# idempotent; npm skips work if the lockfile is already in sync.
npm install --omit=dev --no-audit --no-fund --prefer-offline >/dev/null

# Package entrypoint, static assets, local modules, runtime node_modules,
# and the wallet-pass icon/logo bundle. Wallet assets are optional — the
# directory may not exist in environments that haven't provisioned the
# Apple Pass Type ID yet; zip's -r handles missing dirs gracefully when
# tested ahead of time.
PACKAGE_PATHS=(index.mjs package.json table-template.json lib node_modules)
if [ -d assets ]; then
  PACKAGE_PATHS+=(assets)
fi
zip -r "$ZIP_PATH" "${PACKAGE_PATHS[@]}" >/dev/null

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$ZIP_PATH" \
  --region "$AWS_REGION"

aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION"

aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --timeout "$TIMEOUT_SECONDS" \
  --memory-size "$MEMORY_SIZE_MB" \
  --region "$AWS_REGION"

aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME" \
  --region "$AWS_REGION"

echo "Deployed $FUNCTION_NAME ($AWS_REGION) with timeout=${TIMEOUT_SECONDS}s memory=${MEMORY_SIZE_MB}MB"
