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

# Package entrypoint, static assets, and all local modules used by index.mjs.
zip -r "$ZIP_PATH" index.mjs table-template.json lib >/dev/null

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
