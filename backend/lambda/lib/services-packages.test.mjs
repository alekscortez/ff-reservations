// Tests for services-packages.mjs (admin package CRUD). Cover the
// bilingual i18n normalizer, the projectItem shape, list/sort, and the
// delete pattern (soft-delete on first call when ACTIVE, hard-delete
// when already INACTIVE — the only place in the codebase with this
// 2-stage delete).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createPackagesService } from "./services-packages.mjs";

const FIXED_NOW = 1_700_000_000;

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function makeFakeDdb({ getResponses = [], queryResponses = [], throwOnCommand } = {}) {
  let getIdx = 0;
  let qIdx = 0;
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (throwOnCommand?.[name]) throw throwOnCommand[name];
      if (name === "GetCommand") return getResponses[getIdx++] ?? { Item: null };
      if (name === "QueryCommand") return queryResponses[qIdx++] ?? { Items: [] };
      if (name === "UpdateCommand") {
        // Echo input as ALL_NEW Attributes
        return {
          Attributes: {
            packageId: cmd.input.Key.SK.slice("PACKAGE#".length),
            ...(cmd.input.ExpressionAttributeValues ?? {}),
          },
        };
      }
      return {};
    },
  };
}

function buildService(overrides = {}) {
  const ddb = overrides.ddb ?? makeFakeDdb();
  let uuidCounter = 0;
  const svc = createPackagesService({
    ddb,
    tableNames: { PACKAGES_TABLE: "ff-packages" },
    nowEpoch: () => FIXED_NOW,
    httpError,
    randomUUID: overrides.randomUUID ?? (() => `uuid-${++uuidCounter}`),
  });
  return { ddb, svc };
}

// ---------------------------------------------------------------------------
// listPackages
// ---------------------------------------------------------------------------

describe("listPackages", () => {
  it("queries with PACKAGE PK + PACKAGE# SK prefix", async () => {
    const ddb = makeFakeDdb({ queryResponses: [{ Items: [] }] });
    const { svc } = buildService({ ddb });
    await svc.listPackages();
    const q = ddb.calls[0];
    assert.equal(q.name, "QueryCommand");
    assert.equal(q.input.TableName, "ff-packages");
    assert.equal(q.input.ExpressionAttributeValues[":pk"], "PACKAGE");
    assert.equal(q.input.ExpressionAttributeValues[":sk"], "PACKAGE#");
  });

  it("sorts by displayOrder ascending, then by name as tiebreaker", async () => {
    const items = [
      { packageId: "p1", name: "Bravo", displayOrder: 2 },
      { packageId: "p2", name: "Alpha", displayOrder: 1 },
      { packageId: "p3", name: "Charlie", displayOrder: 1 },
      { packageId: "p4", name: "Delta", displayOrder: 0 },
    ];
    const ddb = makeFakeDdb({ queryResponses: [{ Items: items }] });
    const { svc } = buildService({ ddb });
    const out = await svc.listPackages();
    assert.deepEqual(
      out.map((p) => p.packageId),
      ["p4", "p2", "p3", "p1"] // 0, 1(Alpha), 1(Charlie), 2
    );
  });

  it("activeOnly filter excludes INACTIVE packages", async () => {
    const items = [
      { packageId: "p1", name: "X", displayOrder: 0, status: "ACTIVE" },
      { packageId: "p2", name: "Y", displayOrder: 1, status: "INACTIVE" },
      { packageId: "p3", name: "Z", displayOrder: 2, status: "ACTIVE" },
    ];
    const ddb = makeFakeDdb({ queryResponses: [{ Items: items }] });
    const { svc } = buildService({ ddb });
    const out = await svc.listPackages({ activeOnly: true });
    assert.deepEqual(
      out.map((p) => p.packageId),
      ["p1", "p3"]
    );
  });

  it("defaults missing fields via projectItem (status='ACTIVE', displayOrder=0, etc.)", async () => {
    const items = [{ packageId: "p1", name: "X" }];
    const ddb = makeFakeDdb({ queryResponses: [{ Items: items }] });
    const { svc } = buildService({ ddb });
    const [out] = await svc.listPackages();
    assert.equal(out.status, "ACTIVE");
    assert.equal(out.displayOrder, 0);
    assert.equal(out.priceUSD, 0);
    assert.equal(out.description, "");
    assert.deepEqual(out.inclusions, []);
    assert.equal(out.imageUrl, null);
    assert.equal(out.i18n, null);
    assert.equal(out.updatedAt, null);
    assert.equal(out.updatedBy, null);
  });

  it("returns [] when no items", async () => {
    const ddb = makeFakeDdb({ queryResponses: [{ Items: [] }] });
    const { svc } = buildService({ ddb });
    assert.deepEqual(await svc.listPackages(), []);
  });
});

// ---------------------------------------------------------------------------
// getPackageById
// ---------------------------------------------------------------------------

describe("getPackageById", () => {
  it("returns null when packageId is empty", async () => {
    const { svc } = buildService();
    assert.equal(await svc.getPackageById(""), null);
    assert.equal(await svc.getPackageById(null), null);
  });

  it("returns null when item not found", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ ddb });
    assert.equal(await svc.getPackageById("p1"), null);
  });

  it("projects item with PACKAGE PK + PACKAGE#<id> SK", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: {
            packageId: "p1",
            name: "X",
            priceUSD: 100,
            inclusions: ["a", "b"],
          },
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.getPackageById("p1");
    assert.equal(out.packageId, "p1");
    assert.equal(out.priceUSD, 100);
    assert.deepEqual(out.inclusions, ["a", "b"]);
    // Verify Get key shape
    assert.equal(ddb.calls[0].input.Key.PK, "PACKAGE");
    assert.equal(ddb.calls[0].input.Key.SK, "PACKAGE#p1");
  });
});

// ---------------------------------------------------------------------------
// createPackage validation
// ---------------------------------------------------------------------------

describe("createPackage validation", () => {
  it("400 on missing name", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.createPackage({ priceUSD: 100 }, "u"),
      (err) => err?.statusCode === 400 && /name is required/.test(err.message)
    );
  });

  it("400 on negative priceUSD", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.createPackage({ name: "X", priceUSD: -1 }, "u"),
      (err) => err?.statusCode === 400 && /priceUSD/.test(err.message)
    );
  });

  it("400 on non-finite priceUSD (NaN)", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.createPackage({ name: "X", priceUSD: NaN }, "u"),
      (err) => err?.statusCode === 400
    );
  });

  it("accepts priceUSD=0 (free package)", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    const out = await svc.createPackage({ name: "Free", priceUSD: 0 }, "u");
    assert.equal(out.priceUSD, 0);
  });
});

describe("createPackage happy path", () => {
  it("issues a Put with correct shape + attribute_not_exists guard", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    const out = await svc.createPackage(
      {
        name: "VIP",
        description: "Premium experience",
        priceUSD: 500,
        inclusions: ["Bottle service", "Reserved seating"],
        imageUrl: "https://example.com/img.png",
        displayOrder: 10,
      },
      "staff@x"
    );

    const put = ddb.calls.find((c) => c.name === "PutCommand");
    assert.ok(put);
    assert.equal(put.input.TableName, "ff-packages");
    assert.equal(put.input.Item.PK, "PACKAGE");
    assert.match(put.input.Item.SK, /^PACKAGE#/);
    assert.equal(put.input.Item.name, "VIP");
    assert.equal(put.input.Item.description, "Premium experience");
    assert.equal(put.input.Item.priceUSD, 500);
    assert.deepEqual(put.input.Item.inclusions, ["Bottle service", "Reserved seating"]);
    assert.equal(put.input.Item.imageUrl, "https://example.com/img.png");
    assert.equal(put.input.Item.displayOrder, 10);
    assert.equal(put.input.Item.status, "ACTIVE");
    assert.equal(put.input.Item.createdAt, FIXED_NOW);
    assert.equal(put.input.Item.createdBy, "staff@x");
    assert.equal(
      put.input.ConditionExpression,
      "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    );

    // Returned item is projected
    assert.equal(out.name, "VIP");
    assert.equal(out.priceUSD, 500);
  });

  it("falls back actor to 'system' when not provided", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    await svc.createPackage({ name: "X" });
    const put = ddb.calls.find((c) => c.name === "PutCommand");
    assert.equal(put.input.Item.createdBy, "system");
  });

  it("nullifies imageUrl when missing or whitespace-only", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    await svc.createPackage({ name: "X", imageUrl: "  " });
    const put = ddb.calls.find((c) => c.name === "PutCommand");
    assert.equal(put.input.Item.imageUrl, null);
  });

  it("filters falsy inclusions (drops empty strings)", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    await svc.createPackage({ name: "X", inclusions: ["a", "", "b", null, "c"] });
    const put = ddb.calls.find((c) => c.name === "PutCommand");
    // String(null) === "null" survives — documented quirk in services-clients tests
    assert.deepEqual(put.input.Item.inclusions, ["a", "b", "null", "c"]);
  });

  it("defaults displayOrder to 0 when missing or NaN", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    await svc.createPackage({ name: "X" });
    let put = ddb.calls.find((c) => c.name === "PutCommand");
    assert.equal(put.input.Item.displayOrder, 0);
    await svc.createPackage({ name: "Y", displayOrder: "garbage" });
    put = ddb.calls.filter((c) => c.name === "PutCommand").at(-1);
    assert.equal(put.input.Item.displayOrder, 0);
  });
});

// ---------------------------------------------------------------------------
// normalizeI18n (bilingual content)
// ---------------------------------------------------------------------------

describe("normalizeI18n (via createPackage)", () => {
  async function getStoredI18n(payload) {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    await svc.createPackage({ name: "X", i18n: payload });
    const put = ddb.calls.find((c) => c.name === "PutCommand");
    return put.input.Item.i18n;
  }

  it("returns null when i18n is null/undefined/non-object", async () => {
    assert.equal(await getStoredI18n(null), null);
    assert.equal(await getStoredI18n(undefined), null);
    assert.equal(await getStoredI18n("string"), null);
  });

  it("normalizes en + es blocks", async () => {
    const out = await getStoredI18n({
      en: { name: "VIP", description: "Premium", inclusions: ["Bottle"] },
      es: { name: "VIP MX", description: "Premio", inclusions: ["Botella"] },
    });
    assert.deepEqual(out, {
      en: { name: "VIP", description: "Premium", inclusions: ["Bottle"] },
      es: { name: "VIP MX", description: "Premio", inclusions: ["Botella"] },
    });
  });

  it("ignores languages other than en + es", async () => {
    const out = await getStoredI18n({
      en: { name: "VIP" },
      fr: { name: "VIP FR" },
      jp: { name: "VIP JP" },
    });
    assert.deepEqual(Object.keys(out).sort(), ["en"]);
  });

  it("drops a language block where all fields are empty", async () => {
    const out = await getStoredI18n({
      en: { name: "VIP" },
      es: { name: "", description: "", inclusions: [] },
    });
    assert.deepEqual(Object.keys(out), ["en"]);
  });

  it("returns null when both blocks are empty", async () => {
    const out = await getStoredI18n({
      en: { name: "" },
      es: { name: "" },
    });
    assert.equal(out, null);
  });

  it("filters falsy inclusions per language", async () => {
    const out = await getStoredI18n({
      en: { inclusions: ["a", "", "b"] },
    });
    assert.deepEqual(out.en.inclusions, ["a", "b"]);
  });

  it("trims name + description", async () => {
    const out = await getStoredI18n({
      en: { name: "  VIP  ", description: "  Premium  " },
    });
    assert.equal(out.en.name, "VIP");
    assert.equal(out.en.description, "Premium");
  });
});

// ---------------------------------------------------------------------------
// updatePackage
// ---------------------------------------------------------------------------

describe("updatePackage validation", () => {
  it("404 when package not found", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.updatePackage("p1", { name: "X" }, "u"),
      (err) => err?.statusCode === 404
    );
  });

  it("400 when name is empty string explicitly", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: { packageId: "p1" } }] });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.updatePackage("p1", { name: "  " }, "u"),
      (err) => err?.statusCode === 400 && /name cannot be empty/.test(err.message)
    );
  });

  it("400 on negative priceUSD", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: { packageId: "p1" } }] });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.updatePackage("p1", { priceUSD: -1 }, "u"),
      (err) => err?.statusCode === 400
    );
  });

  it("400 on non-finite displayOrder", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: { packageId: "p1" } }] });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.updatePackage("p1", { displayOrder: "garbage" }, "u"),
      (err) => err?.statusCode === 400 && /displayOrder/.test(err.message)
    );
  });

  it("400 on bad status enum (only ACTIVE/INACTIVE allowed)", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: { packageId: "p1" } }] });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.updatePackage("p1", { status: "ARCHIVED" }, "u"),
      (err) => err?.statusCode === 400 && /status must be/.test(err.message)
    );
  });

  it("status: case-insensitive accept (lowercase 'active' → 'ACTIVE')", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: { packageId: "p1" } }] });
    const { svc } = buildService({ ddb });
    await svc.updatePackage("p1", { status: "active" }, "u");
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.equal(update.input.ExpressionAttributeValues[":status"], "ACTIVE");
  });

  it("400 when no fields to update", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: { packageId: "p1" } }] });
    const { svc } = buildService({ ddb });
    await assert.rejects(
      () => svc.updatePackage("p1", {}, "u"),
      (err) => err?.statusCode === 400 && /No fields/.test(err.message)
    );
  });
});

describe("updatePackage happy path", () => {
  it("updates only the fields provided + always bumps updatedAt + updatedBy", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { packageId: "p1", name: "Old" } }],
    });
    const { svc } = buildService({ ddb });
    await svc.updatePackage("p1", { name: "New", priceUSD: 200 }, "staff@x");

    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.equal(update.input.Key.PK, "PACKAGE");
    assert.equal(update.input.Key.SK, "PACKAGE#p1");
    assert.match(update.input.UpdateExpression, /#name = :name/);
    assert.match(update.input.UpdateExpression, /#priceUSD = :priceUSD/);
    assert.match(update.input.UpdateExpression, /#updatedAt = :updatedAt/);
    assert.match(update.input.UpdateExpression, /#updatedBy = :updatedBy/);
    assert.equal(update.input.ExpressionAttributeValues[":name"], "New");
    assert.equal(update.input.ExpressionAttributeValues[":priceUSD"], 200);
    assert.equal(update.input.ExpressionAttributeValues[":updatedAt"], FIXED_NOW);
    assert.equal(update.input.ExpressionAttributeValues[":updatedBy"], "staff@x");
    // Doesn't include unprovided fields
    assert.equal(update.input.ExpressionAttributeValues[":description"], undefined);
    // attribute_exists guard
    assert.equal(
      update.input.ConditionExpression,
      "attribute_exists(PK) AND attribute_exists(SK)"
    );
  });

  it("nullifies imageUrl when set to whitespace-only string (clearing)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { packageId: "p1" } }],
    });
    const { svc } = buildService({ ddb });
    await svc.updatePackage("p1", { imageUrl: "   " }, "u");
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.equal(update.input.ExpressionAttributeValues[":imageUrl"], null);
  });
});

// ---------------------------------------------------------------------------
// deletePackage (2-stage: ACTIVE → soft-delete, INACTIVE → hard-delete)
// ---------------------------------------------------------------------------

describe("deletePackage", () => {
  it("returns null when package not found", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ ddb });
    const out = await svc.deletePackage("p1", "u");
    assert.equal(out, null);
    // Should not have issued any Delete or Update
    assert.equal(
      ddb.calls.filter((c) => c.name === "DeleteCommand").length,
      0
    );
    assert.equal(
      ddb.calls.filter((c) => c.name === "UpdateCommand").length,
      0
    );
  });

  it("ACTIVE → soft-delete (UpdateCommand sets status=INACTIVE, returns softDeleted:true)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { packageId: "p1", name: "X", status: "ACTIVE" } }],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.deletePackage("p1", "staff@x");
    assert.equal(out.softDeleted, true);
    assert.equal(out.hardDeleted, undefined);

    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.ok(update);
    assert.equal(update.input.Key.SK, "PACKAGE#p1");
    assert.equal(update.input.ExpressionAttributeValues[":inactive"], "INACTIVE");
    assert.equal(update.input.ExpressionAttributeValues[":user"], "staff@x");
    assert.equal(update.input.ExpressionAttributeValues[":now"], FIXED_NOW);
    assert.equal(
      update.input.ConditionExpression,
      "attribute_exists(PK) AND attribute_exists(SK)"
    );
    // No DeleteCommand on first delete of an ACTIVE package
    assert.equal(
      ddb.calls.filter((c) => c.name === "DeleteCommand").length,
      0
    );
  });

  it("INACTIVE → hard-delete (DeleteCommand removes the row, returns hardDeleted:true)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { packageId: "p1", name: "X", status: "INACTIVE" } }],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.deletePackage("p1", "u");
    assert.equal(out.hardDeleted, true);
    assert.equal(out.softDeleted, undefined);
    assert.equal(out.packageId, "p1");

    const del = ddb.calls.find((c) => c.name === "DeleteCommand");
    assert.ok(del);
    assert.equal(del.input.Key.PK, "PACKAGE");
    assert.equal(del.input.Key.SK, "PACKAGE#p1");
    // No Update on hard-delete
    assert.equal(
      ddb.calls.filter((c) => c.name === "UpdateCommand").length,
      0
    );
  });

  it("falls back actor to 'system' when not provided (soft-delete path)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { packageId: "p1", status: "ACTIVE" } }],
    });
    const { svc } = buildService({ ddb });
    await svc.deletePackage("p1");
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.equal(update.input.ExpressionAttributeValues[":user"], "system");
  });
});
