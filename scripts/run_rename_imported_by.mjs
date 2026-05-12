#!/usr/bin/env node
// Renames updatedBy + importedBy from "spreadsheet-import-2026-05-11" → "Legacy"
// across the 1,404 rows imported earlier today. Uses ConditionExpression so we
// only touch rows that still show the verbose label — any row that's been
// edited in the meantime (or was one of the 4 skipped originals) is left alone.
//
// Usage:
//   FF_DRY_RUN=1 node scripts/run_rename_imported_by.mjs   # count would-update / would-skip
//   node scripts/run_rename_imported_by.mjs                # apply the rename

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = resolve(__dirname, "out", "contacts_dedup.json");
const REGION = process.env.AWS_REGION ?? "us-east-1";
const DRY_RUN = process.env.FF_DRY_RUN === "1";
const OLD_LABEL = "spreadsheet-import-2026-05-11";
const NEW_LABEL = "Legacy";
const TABLE = "ff-clients";
const CONCURRENCY = 10;

function phoneKey(e164) {
  return e164.replace(/[^\d]/g, "");
}

async function main() {
  const all = JSON.parse(await readFile(INPUT_FILE, "utf8"));
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  const totals = { renamed: 0, skipped: 0, errors: 0, missing: 0 };
  const errorDetails = [];
  let cursor = 0;

  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}rename updatedBy + importedBy: "${OLD_LABEL}" → "${NEW_LABEL}"`
  );
  console.log(`${all.length} candidate rows from contacts_dedup.json`);

  async function worker() {
    while (cursor < all.length) {
      const i = cursor++;
      const sk = `PHONE#${phoneKey(all[i].phoneE164)}`;

      if (DRY_RUN) {
        // Just GetItem and report what would happen
        try {
          const got = await ddb.send(
            new GetCommand({ TableName: TABLE, Key: { PK: "CLIENT", SK: sk } })
          );
          if (!got.Item) {
            totals.missing += 1;
            continue;
          }
          if (got.Item.updatedBy === OLD_LABEL && got.Item.importedBy === OLD_LABEL) {
            totals.renamed += 1;
          } else {
            totals.skipped += 1;
          }
        } catch (err) {
          totals.errors += 1;
          errorDetails.push({ sk, error: String(err?.message ?? err) });
        }
        continue;
      }

      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK: "CLIENT", SK: sk },
            UpdateExpression: "SET #updatedBy = :new, #importedBy = :new",
            ConditionExpression:
              "#updatedBy = :old AND #importedBy = :old",
            ExpressionAttributeNames: {
              "#updatedBy": "updatedBy",
              "#importedBy": "importedBy",
            },
            ExpressionAttributeValues: {
              ":new": NEW_LABEL,
              ":old": OLD_LABEL,
            },
          })
        );
        totals.renamed += 1;
      } catch (err) {
        if (err?.name === "ConditionalCheckFailedException") {
          totals.skipped += 1;
        } else {
          totals.errors += 1;
          errorDetails.push({ sk, error: String(err?.message ?? err) });
        }
      }
    }
  }

  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, all.length) }, worker)
  );
  const dt = Date.now() - t0;

  console.log(`\n=== ${DRY_RUN ? "DRY-RUN " : ""}TOTALS (${dt}ms) ===`);
  console.log(`  renamed : ${totals.renamed}`);
  console.log(`  skipped : ${totals.skipped}  (already changed, or row never had old label)`);
  console.log(`  missing : ${totals.missing}  (row not in DDB — should be 0)`);
  console.log(`  errors  : ${totals.errors}`);
  if (errorDetails.length) {
    console.log("\n=== ERRORS (first 10) ===");
    for (const d of errorDetails.slice(0, 10)) {
      console.log(`  ${d.sk}: ${d.error}`);
    }
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
