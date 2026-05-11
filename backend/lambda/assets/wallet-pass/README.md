# Apple Wallet pass assets

Drop the following PNGs in this directory before deploying. If any are
missing the wallet pass route returns 501 WALLET_PASS_NOT_CONFIGURED
(see `services-wallet-pass.mjs` + cold-start `loadWalletPassAsset` in
`index.mjs`).

Required (Apple spec):

| File              | Size       | Notes                                          |
|-------------------|------------|------------------------------------------------|
| `icon.png`        | 29 × 29    | Shown on lock-screen notifications + Wallet list |
| `icon@2x.png`     | 58 × 58    | Retina                                         |
| `logo.png`        | ≤ 160 × 50 | Top-left brand mark on the pass                |
| `logo@2x.png`     | ≤ 320 × 100| Retina                                         |

Optional (only included if present at deploy time):

| File              | Size       | Notes                                          |
|-------------------|------------|------------------------------------------------|
| `icon@3x.png`     | 87 × 87    | Super-retina (iPhone Plus / Pro Max)           |
| `logo@3x.png`     | ≤ 480 × 150| Super-retina                                   |

## Generating from a single source

If you have a square brand PNG at high resolution (e.g. the mobile app
icon, `apps/mobile/assets/images/icon.png` in the customer-mobile repo),
`sips` (macOS built-in) can produce the icon set in one shot:

```bash
SRC=apps/mobile/assets/images/icon.png
DST=backend/lambda/assets/wallet-pass
sips -z 29 29 "$SRC" --out "$DST/icon.png"
sips -z 58 58 "$SRC" --out "$DST/icon@2x.png"
sips -z 87 87 "$SRC" --out "$DST/icon@3x.png"
```

For the logo, design a transparent-background brand wordmark PNG sized to
roughly 320 × 100 (with retina alpha), then drop it as `logo@2x.png` and
let `logo.png` be a 50% downscale. Apple Wallet sizes the logo into the
header bar — text-based logos tend to read better than icon-only ones.

## Not committed

Source PNGs are not part of the repo. Drop them here locally before running
`./deploy.sh`. CI/CD should resolve them from an out-of-band channel (S3,
SSM Parameter Store, or a private artifact registry) before invoking the
deploy.
