# Cognito Pre Token Generation Lambda

Injects `cognito:groups` into Cognito **access tokens**. Required by this
app — without it, every authenticated request returns `403 Admin/Staff
privileges required`. See the "Auth model" section of `/CLAUDE.md`.

## One-time deploy

```bash
cd backend/cognito-pre-token-gen

# 1. Create the function (first time only)
zip -r function.zip index.mjs
aws lambda create-function \
  --function-name ff-reservations-pretoken \
  --runtime nodejs22.x \
  --role arn:aws:iam::<ACCOUNT_ID>:role/ff-reservations-pretoken-role \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --timeout 5 --memory-size 128 \
  --region us-east-1

# 2. Allow Cognito to invoke it
aws lambda add-permission \
  --function-name ff-reservations-pretoken \
  --statement-id cognito-invoke \
  --action lambda:InvokeFunction \
  --principal cognito-idp.amazonaws.com \
  --source-arn arn:aws:cognito-idp:us-east-1:<ACCOUNT_ID>:userpool/us-east-1_Upsi9Q2Tc \
  --region us-east-1

# 3. Wire trigger on the user pool (TRIGGER VERSION MUST BE V2_0)
aws cognito-idp update-user-pool \
  --user-pool-id us-east-1_Upsi9Q2Tc \
  --lambda-config '{
    "PreTokenGenerationConfig": {
      "LambdaArn": "arn:aws:lambda:us-east-1:<ACCOUNT_ID>:function:ff-reservations-pretoken",
      "LambdaVersion": "V2_0"
    }
  }' \
  --region us-east-1
```

The IAM role only needs the basic `AWSLambdaBasicExecutionRole` managed
policy (CloudWatch Logs). The currently deployed function uses a
console-generated service role (e.g. `ff-reservations-pretoken-role-xxxxxxxx`);
substitute that ARN above if you're updating, or create one explicitly.

> **Function name note:** the live function is `ff-reservations-pretoken`
> (no hyphens between "pre", "token", "gen"). An earlier draft of this
> README documented `ff-reservations-pre-token-gen`, which does not exist
> in the AWS account. Always cross-check with `aws lambda list-functions`
> before deploying.

## Updates

```bash
zip -r function.zip index.mjs
aws lambda update-function-code \
  --function-name ff-reservations-pretoken \
  --zip-file fileb://function.zip \
  --region us-east-1
```

## Verification

After deploying, sign out + back in (refresh tokens issued before the
trigger was wired do not contain the groups claim):

```bash
curl -s https://api.famosofuego.com/admin/whoami \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq
```

Expect `hasGroups: true` and `groups: ["Admin"]` (or similar). If
`hasGroups: false` after re-login, check the trigger ARN, the v2 version
flag, and the function's CloudWatch logs.

## Why v2 specifically

Cognito v1 triggers (`PreTokenGeneration`) can only modify the **ID** token.
v2 (`PreTokenGenerationConfig` + `V2_0`) is the only version that can add
claims to **access** tokens, which is what API Gateway's JWT authorizer
validates and what the backend reads.
