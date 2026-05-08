import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export function createEventsService({
  ddb,
  tableNames,
  nowEpoch,
  httpError,
  randomUUID,
  createFrequentReservationsForEvent,
}) {
  const { EVENTS_TABLE } = tableNames;

  async function listEvents() {
    const res = await ddb.send(
      new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": "EVENT",
          ":sk": "EVENT#",
        },
      })
    );

    const items = (res.Items ?? []).map((x) => ({
      eventId: x.eventId,
      eventName: x.eventName,
      eventDate: x.eventDate,
      status: x.status,
      minDeposit: x.minDeposit,
      tablePricing: x.tablePricing ?? {},
      sectionPricing: x.sectionPricing ?? {},
      disabledTables: x.disabledTables ?? [],
      disabledClients: x.disabledClients ?? [],
      frequentReleasedTables: x.frequentReleasedTables ?? [],
      createdAt: x.createdAt,
      createdBy: x.createdBy,
    }));

    items.sort((a, b) => (a.eventDate || "").localeCompare(b.eventDate || ""));
    return items;
  }

  async function createEvent(payload, user) {
    const eventName = String(payload?.eventName ?? "").trim();
    const eventDate = String(payload?.eventDate ?? "").trim();
    const minDeposit = Number(payload?.minDeposit ?? 0);

    if (!eventName) throw httpError(400, "eventName is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw httpError(400, "eventDate must be YYYY-MM-DD");
    if (!Number.isFinite(minDeposit) || minDeposit < 0) throw httpError(400, "minDeposit must be >= 0");

    const eventId = `${Date.now()}-${randomUUID()}`;

    const eventItem = {
      PK: "EVENT",
      SK: `EVENT#${eventId}`,
      eventId,
      eventName,
      eventDate,
      status: "ACTIVE",
      minDeposit,
      tablePricing: payload?.tablePricing ?? {},
      sectionPricing: payload?.sectionPricing ?? {},
      disabledTables: payload?.disabledTables ?? [],
      disabledClients: payload?.disabledClients ?? [],
      frequentReleasedTables: [],
      createdAt: nowEpoch(),
      createdBy: user ?? "system",
    };

    const lockItem = {
      PK: "EVENTDATE",
      SK: `DATE#${eventDate}`,
      eventDate,
      eventId,
      createdAt: nowEpoch(),
    };

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: EVENTS_TABLE,
                Item: lockItem,
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              },
            },
            {
              Put: {
                TableName: EVENTS_TABLE,
                Item: eventItem,
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              },
            },
          ],
        })
      );
    } catch (err) {
      if (err?.name === "TransactionCanceledException") {
        throw httpError(409, `An event already exists for ${eventDate}`);
      }
      throw err;
    }

    await createFrequentReservationsForEvent(eventItem, user ?? "system");
    return eventItem;
  }

  async function getEventById(eventId) {
    const res = await ddb.send(
      new GetCommand({
        TableName: EVENTS_TABLE,
        Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
      })
    );
    return res.Item ?? null;
  }

  async function getEventByDate(eventDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      throw httpError(400, "eventDate must be YYYY-MM-DD");
    }

    const lockRes = await ddb.send(
      new GetCommand({
        TableName: EVENTS_TABLE,
        Key: { PK: "EVENTDATE", SK: `DATE#${eventDate}` },
      })
    );

    const lock = lockRes.Item;
    if (!lock?.eventId) return null;

    return await getEventById(lock.eventId);
  }

  async function updateEvent(eventId, payload, user) {
    const current = await getEventById(eventId);
    if (!current) throw httpError(404, "Event not found");

    const nextStatus = payload?.status ?? current.status;

    const updates = [];
    const names = {};
    const values = {};

    const updatable = [
      "eventName",
      "eventDate",
      "status",
      "minDeposit",
      "tablePricing",
      "sectionPricing",
      "disabledTables",
      "disabledClients",
    ];
    for (const key of updatable) {
      if (payload?.[key] !== undefined) {
        updates.push(`#${key} = :${key}`);
        names[`#${key}`] = key;
        values[`:${key}`] = payload[key];
      }
    }
    updates.push("#updatedAt = :updatedAt");
    names["#updatedAt"] = "updatedAt";
    values[":updatedAt"] = nowEpoch();

    if (updates.length === 0) throw httpError(400, "No fields to update");

    if (current.status !== "INACTIVE" && nextStatus === "INACTIVE") {
      const lockKey = { PK: "EVENTDATE", SK: `DATE#${current.eventDate}` };

      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: EVENTS_TABLE,
                Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
                UpdateExpression: "SET " + updates.join(", "),
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
            {
              Delete: {
                TableName: EVENTS_TABLE,
                Key: lockKey,
                ConditionExpression: "eventId = :eid",
                ExpressionAttributeValues: { ":eid": eventId },
              },
            },
          ],
        })
      );

      return await getEventById(eventId);
    }

    if (current.status === "INACTIVE" && nextStatus === "ACTIVE") {
      const lockItem = {
        PK: "EVENTDATE",
        SK: `DATE#${current.eventDate}`,
        eventDate: current.eventDate,
        eventId,
        createdAt: nowEpoch(),
      };

      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: EVENTS_TABLE,
                  Item: lockItem,
                  ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
                },
              },
              {
                Update: {
                  TableName: EVENTS_TABLE,
                  Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
                  UpdateExpression: "SET " + updates.join(", "),
                  ExpressionAttributeNames: names,
                  ExpressionAttributeValues: values,
                },
              },
            ],
          })
        );
      } catch (err) {
        if (err?.name === "TransactionCanceledException") {
          throw httpError(409, `An event already exists for ${current.eventDate}`);
        }
        throw err;
      }

      const updated = await getEventById(eventId);
      if (updated) {
        await createFrequentReservationsForEvent(updated, user ?? "system");
      }
      return updated;
    }

    if (payload?.eventDate && payload.eventDate !== current.eventDate && current.status === "ACTIVE") {
      throw httpError(400, "Changing eventDate for an ACTIVE event is not allowed yet.");
    }

    const res = await ddb.send(
      new UpdateCommand({
        TableName: EVENTS_TABLE,
        Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
        UpdateExpression: "SET " + updates.join(", "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );

    return res.Attributes;
  }

  async function deleteEvent(eventId) {
    const current = await getEventById(eventId);
    if (!current) return;

    if (current.status === "ACTIVE") {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: EVENTS_TABLE,
                Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
              },
            },
            {
              Delete: {
                TableName: EVENTS_TABLE,
                Key: { PK: "EVENTDATE", SK: `DATE#${current.eventDate}` },
                ConditionExpression: "eventId = :eid",
                ExpressionAttributeValues: { ":eid": eventId },
              },
            },
          ],
        })
      );
      return;
    }

    await ddb.send(
      new DeleteCommand({
        TableName: EVENTS_TABLE,
        Key: { PK: "EVENT", SK: `EVENT#${eventId}` },
      })
    );
  }

  return {
    listEvents,
    createEvent,
    getEventById,
    getEventByDate,
    updateEvent,
    deleteEvent,
  };
}
