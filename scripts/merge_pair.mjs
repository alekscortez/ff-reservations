#!/usr/bin/env node
// Merge a duplicate CRM-client row pair: fold ORPHAN's totalReservations +
// totalSpend into CANONICAL, take MAX(lastReservationAt) and the latest
// lastEventDate, then delete ORPHAN.
//
// Idempotent: if you re-run after a successful merge, the orphan won't exist
// → script exits cleanly with "orphan already merged".
//
// Usage:
//   node scripts/merge_pair.mjs <canonicalPhoneE164> <orphanPhoneE164> [--apply]
//   # default is dry-run; pass --apply to actually write.
//
// Example:
//   node scripts/merge_pair.mjs +19564147489 +19564147498 --apply

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const [, , canonicalArg, orphanArg, ...flags] = process.argv;
const APPLY = flags.includes("--apply");
const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE = "ff-clients";

if (!canonicalArg || !orphanArg) {
  console.error("usage: node scripts/merge_pair.mjs <canonicalE164> <orphanE164> [--apply]");
  process.exit(2);
}

const phoneKey = (e) => e.replace(/[^\d]/g, "");
const canonicalSk = `PHONE#${phoneKey(canonicalArg)}`;
const orphanSk = `PHONE#${phoneKey(orphanArg)}`;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function getRow(sk) {
  const got = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: "CLIENT", SK: sk } })
  );
  return got.Item ?? null;
}

function fmt(item) {
  if (!item) return "(missing)";
  return JSON.stringify(
    {
      name: item.name,
      phone: item.phone,
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

const canonical = await getRow(canonicalSk);
const orphan = await getRow(orphanSk);

if (!canonical) {
  console.error(`canonical row not found: ${canonicalSk}`);
  process.exit(1);
}
if (!orphan) {
  console.log(`orphan ${orphanSk} not present — already merged or never existed. nothing to do.`);
  process.exit(0);
}

const orphanCount = Number(orphan.totalReservations ?? 0);
const orphanSpend = Number(orphan.totalSpend ?? 0);
const orphanLastAt = Number(orphan.lastReservationAt ?? 0);
const canonicalLastAt = Number(canonical.lastReservationAt ?? 0);

// pick the more recent lastEventDate (string compare on ISO YYYY-MM-DD works)
const cDate = String(canonical.lastEventDate ?? "");
const oDate = String(orphan.lastEventDate ?? "");
const winningDate = oDate > cDate ? oDate : cDate;
const winningAt = Math.max(canonicalLastAt, orphanLastAt);

const projected = {
  ...canonical,
  totalReservations: Number(canonical.totalReservations ?? 0) + orphanCount,
  totalSpend: Number(canonical.totalSpend ?? 0) + orphanSpend,
  lastEventDate: winningDate || canonical.lastEventDate,
  lastReservationAt: winningAt || canonical.lastReservationAt,
};

console.log("=== CANONICAL (kept) ===");
console.log("BEFORE:", fmt(canonical));
console.log("AFTER :", fmt(projected));
console.log("\n=== ORPHAN (deleted) ===");
console.log(fmt(orphan));

if (!APPLY) {
  console.log("\n[DRY RUN] re-run with --apply to write changes.");
  process.exit(0);
}

// 1) ADD/SET on canonical
const sets = [];
const adds = ["#totalReservations :count", "#totalSpend :spend"];
const names = {
  "#totalReservations": "totalReservations",
  "#totalSpend": "totalSpend",
};
const values = {
  ":count": orphanCount,
  ":spend": orphanSpend,
};
if (winningDate && winningDate !== cDate) {
  sets.push("#lastEventDate = :lastEventDate");
  names["#lastEventDate"] = "lastEventDate";
  values[":lastEventDate"] = winningDate;
}
if (winningAt && winningAt !== canonicalLastAt) {
  sets.push("#lastReservationAt = :lastReservationAt");
  names["#lastReservationAt"] = "lastReservationAt";
  values[":lastReservationAt"] = winningAt;
}

await ddb.send(
  new UpdateCommand({
    TableName: TABLE,
    Key: { PK: "CLIENT", SK: canonicalSk },
    UpdateExpression:
      (sets.length ? `SET ${sets.join(", ")} ` : "") + `ADD ${adds.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  })
);
console.log(`\n→ canonical ${canonicalSk} updated`);

// 2) DELETE orphan
await ddb.send(
  new DeleteCommand({
    TableName: TABLE,
    Key: { PK: "CLIENT", SK: orphanSk },
  })
);
console.log(`→ orphan ${orphanSk} deleted`);
console.log("\nmerge complete.");
