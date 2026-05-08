# Lambda (ff-reservations-api)

This folder contains the Lambda source for the `ff-reservations-api` function.

## Files
- `index.mjs` — Lambda handler (ESM)
- `deploy.sh` — zips and deploys the handler using AWS CLI

## Deploy

```bash
./deploy.sh
```

This will:
1. Zip `index.mjs` into `function.zip`
2. Deploy it to the Lambda function in `us-east-1`

## Notes
- Make sure AWS CLI is configured (`aws sts get-caller-identity`)
- `function.zip` is generated locally and should not be committed
