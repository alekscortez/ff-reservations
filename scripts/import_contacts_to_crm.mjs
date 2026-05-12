#!/usr/bin/env node
// Posts the deduped contacts (scripts/out/contacts_dedup.json) to the lambda's
// POST /clients/bulk-import endpoint, in chunks. Run after deploying the lambda
// + creating the API Gateway route. Reads the admin bearer token from the
// FF_ADMIN_TOKEN env var.
//
// Usage:
//   FF_ADMIN_TOKEN="eyJraWQ..." node scripts/import_contacts_to_crm.mjs
//
// Optional env:
//   FF_API_BASE      override base URL (default https://api.famosofuego.com)
//   FF_INPUT_FILE    override input JSON (default scripts/out/contacts_dedup.json)
//   FF_CHUNK_SIZE    contacts per request (default 200, server caps at 500)
//   FF_DRY_RUN=1     print what would be posted without calling the API

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = process.env.FF_API_BASE ?? "https://api.famosofuego.com";
const INPUT_FILE =
  process.env.FF_INPUT_FILE ?? resolve(__dirname, "out", "contacts_dedup.json");
const CHUNK_SIZE = Math.min(500, Math.max(1, Number(process.env.FF_CHUNK_SIZE ?? 200)));
const DRY_RUN = process.env.FF_DRY_RUN === "1";
const TOKEN = process.env.FF_ADMIN_TOKEN;

if (!DRY_RUN && !TOKEN) {
  console.error(
    "error: FF_ADMIN_TOKEN env var is required (admin Cognito access token).\n" +
      "  Easiest way: log into the app as admin → open dev tools → Network tab →\n" +
      "  click any /admin/whoami or /clients call → copy the value after 'Bearer ' in the Authorization header.\n" +
      "  Then run:  FF_ADMIN_TOKEN=\"eyJ…\" node scripts/import_contacts_to_crm.mjs"
  );
  process.exit(2);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function postChunk(contacts) {
  const url = `${API_BASE}/clients/bulk-import`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ contacts }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
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
      (DRY_RUN ? " [DRY RUN]" : ` → POST ${API_BASE}/clients/bulk-import`)
  );

  if (DRY_RUN) {
    console.log("first 3 contacts in first chunk:");
    for (const c of chunks[0].slice(0, 3)) console.log("  ", c);
    return;
  }

  const totals = { imported: 0, skipped: 0, invalid: 0, errors: 0 };
  for (let i = 0; i < chunks.length; i++) {
    const chunkContacts = chunks[i];
    process.stdout.write(`chunk ${i + 1}/${chunks.length} (${chunkContacts.length} rows)… `);
    try {
      const t0 = Date.now();
      const summary = await postChunk(chunkContacts);
      const dt = Date.now() - t0;
      totals.imported += summary.imported ?? 0;
      totals.skipped += summary.skipped ?? 0;
      totals.invalid += summary.invalid ?? 0;
      totals.errors += summary.errors ?? 0;
      console.log(
        `ok ${dt}ms  imported=${summary.imported}  skipped=${summary.skipped}  invalid=${summary.invalid}  errors=${summary.errors}`
      );
      if (summary.invalidDetails?.length) {
        for (const d of summary.invalidDetails.slice(0, 5)) {
          console.log(`    invalid: phone=${d.phone}  reason=${d.reason}`);
        }
        if (summary.invalidDetails.length > 5) {
          console.log(`    …and ${summary.invalidDetails.length - 5} more invalid`);
        }
      }
      if (summary.errorDetails?.length) {
        for (const d of summary.errorDetails.slice(0, 5)) {
          console.log(`    error: phone=${d.phone}  ${d.error}`);
        }
      }
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      console.log("aborting — partial progress preserved server-side. Re-run is safe (idempotent).");
      process.exit(1);
    }
  }

  console.log("\n=== TOTALS ===");
  console.log(`  imported : ${totals.imported}`);
  console.log(`  skipped  : ${totals.skipped}  (already existed in CRM — left untouched)`);
  console.log(`  invalid  : ${totals.invalid}  (bad payload — see logs above)`);
  console.log(`  errors   : ${totals.errors}   (DDB issues — re-run is safe)`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
