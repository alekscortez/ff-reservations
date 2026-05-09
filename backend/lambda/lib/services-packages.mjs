import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export function createPackagesService({
  ddb,
  tableNames,
  nowEpoch,
  httpError,
  randomUUID,
}) {
  const { PACKAGES_TABLE } = tableNames;

  const PK_VALUE = "PACKAGE";
  const SK_PREFIX = "PACKAGE#";

  function normalizeI18n(input) {
    if (!input || typeof input !== "object") return null;
    const out = {};
    for (const lang of ["en", "es"]) {
      const block = input[lang];
      if (!block || typeof block !== "object") continue;
      const name = String(block.name ?? "").trim();
      const description = String(block.description ?? "").trim();
      const inclusions = Array.isArray(block.inclusions)
        ? block.inclusions.map((s) => String(s)).filter(Boolean)
        : [];
      if (!name && !description && inclusions.length === 0) continue;
      out[lang] = { name, description, inclusions };
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  function projectItem(item) {
    if (!item) return null;
    return {
      packageId: item.packageId,
      name: item.name,
      description: item.description ?? "",
      priceUSD: Number(item.priceUSD ?? 0),
      inclusions: Array.isArray(item.inclusions) ? item.inclusions : [],
      imageUrl: item.imageUrl ?? null,
      displayOrder: Number(item.displayOrder ?? 0),
      i18n: item.i18n ?? null,
      status: item.status ?? "ACTIVE",
      createdAt: item.createdAt,
      createdBy: item.createdBy,
      updatedAt: item.updatedAt ?? null,
      updatedBy: item.updatedBy ?? null,
    };
  }

  async function listPackages({ activeOnly = false } = {}) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: PACKAGES_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": PK_VALUE,
          ":sk": SK_PREFIX,
        },
      })
    );

    const items = (res.Items ?? [])
      .map(projectItem)
      .filter((p) => !activeOnly || p.status === "ACTIVE")
      .sort((a, b) => {
        const orderDiff = (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
        if (orderDiff !== 0) return orderDiff;
        return String(a.name ?? "").localeCompare(String(b.name ?? ""));
      });

    return items;
  }

  async function getPackageById(packageId) {
    if (!packageId) return null;
    const res = await ddb.send(
      new GetCommand({
        TableName: PACKAGES_TABLE,
        Key: { PK: PK_VALUE, SK: `${SK_PREFIX}${packageId}` },
      })
    );
    return projectItem(res.Item);
  }

  async function createPackage(payload, user) {
    const name = String(payload?.name ?? "").trim();
    if (!name) throw httpError(400, "name is required");

    const description = String(payload?.description ?? "").trim();
    const priceUSD = Number(payload?.priceUSD ?? 0);
    if (!Number.isFinite(priceUSD) || priceUSD < 0) {
      throw httpError(400, "priceUSD must be a non-negative number");
    }

    const inclusions = Array.isArray(payload?.inclusions)
      ? payload.inclusions.map((s) => String(s)).filter(Boolean)
      : [];

    const imageUrl =
      typeof payload?.imageUrl === "string" && payload.imageUrl.trim()
        ? payload.imageUrl.trim()
        : null;

    const displayOrder = Number.isFinite(Number(payload?.displayOrder))
      ? Number(payload.displayOrder)
      : 0;

    const i18n = normalizeI18n(payload?.i18n);

    const packageId = `${Date.now()}-${randomUUID()}`;

    const item = {
      PK: PK_VALUE,
      SK: `${SK_PREFIX}${packageId}`,
      packageId,
      name,
      description,
      priceUSD,
      inclusions,
      imageUrl,
      displayOrder,
      i18n,
      status: "ACTIVE",
      createdAt: nowEpoch(),
      createdBy: user ?? "system",
    };

    await ddb.send(
      new PutCommand({
        TableName: PACKAGES_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      })
    );

    return projectItem(item);
  }

  async function updatePackage(packageId, payload, user) {
    const current = await getPackageById(packageId);
    if (!current) throw httpError(404, "Package not found");

    const updates = [];
    const names = {};
    const values = {};

    function setField(field, raw) {
      updates.push(`#${field} = :${field}`);
      names[`#${field}`] = field;
      values[`:${field}`] = raw;
    }

    if (payload?.name !== undefined) {
      const name = String(payload.name).trim();
      if (!name) throw httpError(400, "name cannot be empty");
      setField("name", name);
    }
    if (payload?.description !== undefined) {
      setField("description", String(payload.description));
    }
    if (payload?.priceUSD !== undefined) {
      const priceUSD = Number(payload.priceUSD);
      if (!Number.isFinite(priceUSD) || priceUSD < 0) {
        throw httpError(400, "priceUSD must be a non-negative number");
      }
      setField("priceUSD", priceUSD);
    }
    if (payload?.inclusions !== undefined) {
      const inclusions = Array.isArray(payload.inclusions)
        ? payload.inclusions.map((s) => String(s)).filter(Boolean)
        : [];
      setField("inclusions", inclusions);
    }
    if (payload?.imageUrl !== undefined) {
      const imageUrl =
        typeof payload.imageUrl === "string" && payload.imageUrl.trim()
          ? payload.imageUrl.trim()
          : null;
      setField("imageUrl", imageUrl);
    }
    if (payload?.displayOrder !== undefined) {
      const displayOrder = Number(payload.displayOrder);
      if (!Number.isFinite(displayOrder)) {
        throw httpError(400, "displayOrder must be a number");
      }
      setField("displayOrder", displayOrder);
    }
    if (payload?.i18n !== undefined) {
      setField("i18n", normalizeI18n(payload.i18n));
    }
    if (payload?.status !== undefined) {
      const status = String(payload.status).trim().toUpperCase();
      if (status !== "ACTIVE" && status !== "INACTIVE") {
        throw httpError(400, "status must be ACTIVE or INACTIVE");
      }
      setField("status", status);
    }

    if (updates.length === 0) throw httpError(400, "No fields to update");

    setField("updatedAt", nowEpoch());
    setField("updatedBy", user ?? "system");

    const res = await ddb.send(
      new UpdateCommand({
        TableName: PACKAGES_TABLE,
        Key: { PK: PK_VALUE, SK: `${SK_PREFIX}${packageId}` },
        UpdateExpression: "SET " + updates.join(", "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
        ReturnValues: "ALL_NEW",
      })
    );

    return projectItem(res.Attributes);
  }

  async function deletePackage(packageId, user) {
    const current = await getPackageById(packageId);
    if (!current) return null;

    if (current.status === "INACTIVE") {
      await ddb.send(
        new DeleteCommand({
          TableName: PACKAGES_TABLE,
          Key: { PK: PK_VALUE, SK: `${SK_PREFIX}${packageId}` },
        })
      );
      return { hardDeleted: true, packageId };
    }

    const res = await ddb.send(
      new UpdateCommand({
        TableName: PACKAGES_TABLE,
        Key: { PK: PK_VALUE, SK: `${SK_PREFIX}${packageId}` },
        UpdateExpression:
          "SET #status = :inactive, #updatedAt = :now, #updatedBy = :user",
        ExpressionAttributeNames: {
          "#status": "status",
          "#updatedAt": "updatedAt",
          "#updatedBy": "updatedBy",
        },
        ExpressionAttributeValues: {
          ":inactive": "INACTIVE",
          ":now": nowEpoch(),
          ":user": user ?? "system",
        },
        ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
        ReturnValues: "ALL_NEW",
      })
    );

    return { softDeleted: true, item: projectItem(res.Attributes) };
  }

  return {
    listPackages,
    getPackageById,
    createPackage,
    updatePackage,
    deletePackage,
  };
}
