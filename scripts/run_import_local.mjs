#!/usr/bin/env node
// Runs bulkImportCrmClients() locally with IAM creds against the production
// ff-clients table — bypasses API Gateway + JWT, but uses the EXACT same code
// path as the deployed lambda (createClientsService → bulkImportCrmClients →
// PutCommand with attribute_not_exists conditional).
//
// Usage:
//   node scripts/run_import_local.mjs                  # real run
//   FF_DRY_RUN=1 node scripts/run_import_local.mjs     # validate + count, no DDB writes
//
// Env:
//   FF_INPUT_FILE   override input JSON (default scripts/out/contacts_dedup.json)
//   FF_CHUNK_SIZE   contacts per call (default 200, server caps at 500)
//   AWS_REGION      default us-east-1
//   AWS_PROFILE     default whatever the SDK picks up

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { createClientsService } from "../backend/lambda/lib/services-clients.mjs";
import {
  buildPhoneSearchCandidates,
  detectPhoneCountryFromE164,
  httpError,
  normalizePhone,
  normalizePhoneCountry,
  normalizePhoneE164,
  nowEpoch,
  requiredEnv,
  addDaysToIsoDate,
} from "../backend/lambda/lib/core-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE =
  process.env.FF_INPUT_FILE ?? resolve(__dirname, "out", "contacts_dedup.json");
const CHUNK_SIZE = Math.min(500, Math.max(1, Number(process.env.FF_CHUNK_SIZE ?? 200)));
const DRY_RUN = process.env.FF_DRY_RUN === "1";
const REGION = process.env.AWS_REGION ?? "us-east-1";

// Production tables (same names the lambda env uses)
const TABLE_NAMES = {
  CLIENTS_TABLE: "ff-clients",
  FREQUENT_CLIENTS_TABLE: "ff-frequent-clients",
  HOLDS_TABLE: "ff-table-holds",
  RES_TABLE: "ff-reservations",
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function main() {
  const raw = await readFile(INPUT_FILE, "utf8");
  const all = JSON.parse(raw);
  if (!Array.isArray(all)) {
    console.error(`error: ${INPUT_FILE} must contain a JSON array of contacts`);
    process.exit(2);
  }

  // Map dedup output → bulk-import payload (drop alternateNames + firstEventDate)
  const payload = all.map((c) => ({
    name: c.name,
    phone: c.phoneE164,
    phoneCountry: c.phoneCountry,
    totalReservations: c.totalReservations,
    totalSpend: c.totalSpend,
    lastEventDate: c.lastEventDate,
  }));

  const chunks = chunk(payload, CHUNK_SIZE);
  console.log(
    `loaded ${payload.length} contacts → ${chunks.length} chunk(s) of ≤${CHUNK_SIZE}` +
      (DRY_RUN ? " [DRY RUN — no DDB writes]" : ` → DDB ${TABLE_NAMES.CLIENTS_TABLE} (${REGION})`)
  );

  const ddb = DRY_RUN
    ? makeDryRunDdb()
    : DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  const svc = createClientsService({
    ddb,
    tableNames: TABLE_NAMES,
    requiredEnv,
    normalizePhone,
    normalizePhoneE164,
    normalizePhoneCountry,
    detectPhoneCountryFromE164,
    buildPhoneSearchCandidates,
    nowEpoch,
    httpError,
    addDaysToIsoDate,
    getTablePriceForEvent: () => null, // unused by bulkImportCrmClients
  });

  const totals = { imported: 0, skipped: 0, invalid: 0, errors: 0 };
  const allInvalid = [];
  const allErrors = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkContacts = chunks[i];
    process.stdout.write(`chunk ${i + 1}/${chunks.length} (${chunkContacts.length} rows)… `);
    const t0 = Date.now();
    try {
      const summary = await svc.bulkImportCrmClients(
        { contacts: chunkContacts },
        "Legacy"
      );
      const dt = Date.now() - t0;
      totals.imported += summary.imported;
      totals.skipped += summary.skipped;
      totals.invalid += summary.invalid;
      totals.errors += summary.errors;
      allInvalid.push(...summary.invalidDetails);
      allErrors.push(...summary.errorDetails);
      console.log(
        `${dt}ms  imported=${summary.imported}  skipped=${summary.skipped}  invalid=${summary.invalid}  errors=${summary.errors}`
      );
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      console.log("aborting — partial progress preserved (re-run is safe).");
      process.exit(1);
    }
  }

  console.log("\n=== TOTALS ===");
  console.log(`  imported : ${totals.imported}  (new rows in ff-clients)`);
  console.log(`  skipped  : ${totals.skipped}   (already existed — left untouched)`);
  console.log(`  invalid  : ${totals.invalid}   (bad payload — see below)`);
  console.log(`  errors   : ${totals.errors}    (DDB issues — re-run is safe)`);

  if (allInvalid.length) {
    console.log("\n=== INVALID ROWS (first 20) ===");
    for (const d of allInvalid.slice(0, 20)) {
      console.log(`  index=${d.index}  phone=${d.phone}  reason=${d.reason}`);
    }
    if (allInvalid.length > 20) console.log(`  …and ${allInvalid.length - 20} more`);
  }
  if (allErrors.length) {
    console.log("\n=== ERRORS (first 20) ===");
    for (const d of allErrors.slice(0, 20)) {
      console.log(`  index=${d.index}  phone=${d.phone}  ${d.error}`);
    }
  }
}

// dry-run "DDB" that pretends every Put succeeds
function makeDryRunDdb() {
  return {
    send: async () => ({}),
  };
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
