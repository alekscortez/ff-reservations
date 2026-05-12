#!/usr/bin/env node
// Backfills spreadsheet aggregates onto the 4 rows the import skipped (because
// they already existed in ff-clients from frequent-client sync / admin edits).
//
// Strategy per row:
//   ADD  totalReservations  (additive — safe even if real reservations exist)
//   ADD  totalSpend         (additive)
//   SET  lastEventDate      (only if currently NULL or missing)
//   SET  importedBy = "Legacy", importedAt = <now>
//   DO NOT TOUCH: name, phone, phoneCountry, lastReservationAt, lastTableId,
//                 updatedBy   (preserves real attribution / live state)
//
// Eligibility: a row exists in ff-clients AND its importedBy != "Legacy" — i.e.
// it's one of the 4 originally skipped during the import. For each such row we
// branch on intent:
//   - "backfill": sheet aggregates differ from current (or current is unset).
//     Run the full ADD/SET update.
//   - "considered-only": sheet aggregates exactly match current (likely the same
//     reservations were entered in both systems during transition). Skip the
//     count change to avoid double-counting; only stamp importedBy = "Legacy"
//     and importedAt so the audit trail records that we evaluated this row.
//
// Usage:
//   FF_DRY_RUN=1 node scripts/run_backfill_skipped.mjs   # print before/after
//   node scripts/run_backfill_skipped.mjs                # apply

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = resolve(__dirname, "out", "contacts_dedup.json");
const REGION = process.env.AWS_REGION ?? "us-east-1";
const DRY_RUN = process.env.FF_DRY_RUN === "1";
const TABLE = "ff-clients";
const CONCURRENCY = 10;
const NEW_LABEL = "Legacy";

function phoneKey(e164) {
  return e164.replace(/[^\d]/g, "");
}

function isEligible(item) {
  if (!item) return false;
  // Imported rows carry importedBy = "Legacy" (set by the import + rename
  // passes); the 4 skipped rows do not.
  return item.importedBy !== NEW_LABEL;
}

function classify(sheet, current) {
  const sheetCount = Number(sheet.totalReservations ?? 0);
  const sheetSpend = Number(sheet.totalSpend ?? 0);
  const curCount = Number(current.totalReservations ?? 0);
  const curSpend = Number(current.totalSpend ?? 0);
  if (sheetCount === curCount && sheetSpend === curSpend && sheetCount > 0) {
    // Exact match → likely the same reservations recorded in both systems.
    return "considered-only";
  }
  return "backfill";
}

function fmtItem(item) {
  if (!item) return "(no row)";
  return JSON.stringify(
    {
      name: item.name,
      totalReservations: item.totalReservations ?? null,
      totalSpend: item.totalSpend ?? null,
      lastEventDate: item.lastEventDate ?? null,
      lastReservationAt: item.lastReservationAt ?? null,
      lastTableId: item.lastTableId ?? null,
      updatedBy: item.updatedBy ?? null,
      importedBy: item.importedBy ?? null,
    },
    null,
    2
  );
}

async function main() {
  const all = JSON.parse(await readFile(INPUT_FILE, "utf8"));
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  // Pass 1: identify the eligible rows (concurrent GetItem).
  const eligible = [];
  let cursor = 0;
  async function scanWorker() {
    while (cursor < all.length) {
      const i = cursor++;
      const sheetRow = all[i];
      const sk = `PHONE#${phoneKey(sheetRow.phoneE164)}`;
      const got = await ddb.send(
        new GetCommand({ TableName: TABLE, Key: { PK: "CLIENT", SK: sk } })
      );
      if (isEligible(got.Item)) {
        eligible.push({ sheet: sheetRow, current: got.Item, sk });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, all.length) }, scanWorker)
  );

  console.log(`scanned ${all.length} dedup rows → found ${eligible.length} skipped row(s)`);
  if (eligible.length === 0) {
    console.log("nothing to do.");
    return;
  }

  let backfilled = 0;
  let consideredOnly = 0;

  for (const { sheet, current, sk } of eligible) {
    const action = classify(sheet, current);
    const lastEventDateNeedsSet =
      current.lastEventDate === undefined ||
      current.lastEventDate === null ||
      String(current.lastEventDate).trim() === "";
    const sheetIsoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
      String(sheet.lastEventDate ?? "")
    );

    let projected;
    if (action === "backfill") {
      projected = {
        ...current,
        totalReservations:
          Number(current.totalReservations ?? 0) + Number(sheet.totalReservations ?? 0),
        totalSpend:
          Number(current.totalSpend ?? 0) + Number(sheet.totalSpend ?? 0),
        lastEventDate:
          lastEventDateNeedsSet && sheetIsoMatch ? sheet.lastEventDate : current.lastEventDate,
        importedBy: NEW_LABEL,
        importedAt: Math.floor(Date.now() / 1000),
      };
    } else {
      projected = {
        ...current,
        importedBy: NEW_LABEL,
        importedAt: Math.floor(Date.now() / 1000),
      };
    }

    console.log("\n────────────────────────────────────────────────");
    console.log(
      `SK: ${sk}   action: ${action.toUpperCase()}` +
        `   sheet: name="${sheet.name}", ${sheet.totalReservations}res, $${sheet.totalSpend}, lastEvent=${sheet.lastEventDate}`
    );
    console.log("BEFORE:", fmtItem(current));
    console.log("AFTER :", fmtItem(projected));

    if (DRY_RUN) {
      if (action === "backfill") backfilled += 1;
      else consideredOnly += 1;
      continue;
    }

    if (action === "backfill") {
      const sets = ["#importedBy = :importedBy", "#importedAt = :importedAt"];
      const adds = ["#totalReservations :sheetCount", "#totalSpend :sheetSpend"];
      const names = {
        "#importedBy": "importedBy",
        "#importedAt": "importedAt",
        "#totalReservations": "totalReservations",
        "#totalSpend": "totalSpend",
      };
      const values = {
        ":importedBy": NEW_LABEL,
        ":importedAt": Math.floor(Date.now() / 1000),
        ":sheetCount": Number(sheet.totalReservations ?? 0),
        ":sheetSpend": Number(sheet.totalSpend ?? 0),
      };
      if (lastEventDateNeedsSet && sheetIsoMatch) {
        sets.push("#lastEventDate = :lastEventDate");
        names["#lastEventDate"] = "lastEventDate";
        values[":lastEventDate"] = sheet.lastEventDate;
      }
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: "CLIENT", SK: sk },
          UpdateExpression: `SET ${sets.join(", ")} ADD ${adds.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        })
      );
      backfilled += 1;
    } else {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: "CLIENT", SK: sk },
          UpdateExpression: "SET #importedBy = :importedBy, #importedAt = :importedAt",
          ExpressionAttributeNames: {
            "#importedBy": "importedBy",
            "#importedAt": "importedAt",
          },
          ExpressionAttributeValues: {
            ":importedBy": NEW_LABEL,
            ":importedAt": Math.floor(Date.now() / 1000),
          },
        })
      );
      consideredOnly += 1;
    }
  }

  console.log(
    `\n${DRY_RUN ? "[DRY RUN] " : ""}` +
      `backfilled=${backfilled}  considered-only=${consideredOnly}`
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
