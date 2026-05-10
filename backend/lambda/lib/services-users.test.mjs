// Tests for services-users.mjs (admin user management). Covers the
// pure helpers (toBoolean, normalizeRole, mapAttrs, mapCognitoUserBase,
// asHttpError) plus the factory async surface (listUsers, createUser,
// updateUserRole, updateUserStatus, resetUserPassword, getUserByUsername)
// via fake Cognito.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  asHttpError,
  createUsersService,
  MANAGED_GROUPS,
  mapAttrs,
  mapCognitoUserBase,
  normalizeRole,
  toBoolean,
} from "./services-users.mjs";

const POOL_ID = "us-east-1_test";

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

// Stand-in command shapes — we only care that the factory dispatches
// the correct one. Each command class records its name + input.
function makeCommand(name) {
  return class {
    constructor(input) {
      this.input = input;
    }
    static get commandName() {
      return name;
    }
  };
}

const cognitoCommands = {
  AdminCreateUserCommand: makeCommand("AdminCreateUserCommand"),
  AdminAddUserToGroupCommand: makeCommand("AdminAddUserToGroupCommand"),
  AdminRemoveUserFromGroupCommand: makeCommand("AdminRemoveUserFromGroupCommand"),
  AdminEnableUserCommand: makeCommand("AdminEnableUserCommand"),
  AdminDisableUserCommand: makeCommand("AdminDisableUserCommand"),
  AdminResetUserPasswordCommand: makeCommand("AdminResetUserPasswordCommand"),
  AdminListGroupsForUserCommand: makeCommand("AdminListGroupsForUserCommand"),
  ListUsersCommand: makeCommand("ListUsersCommand"),
  AdminGetUserCommand: makeCommand("AdminGetUserCommand"),
};

function makeFakeCognito({ responses = {}, throwOnCommand } = {}) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.commandName ?? cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (throwOnCommand?.[name]) throw throwOnCommand[name];
      const handler = responses[name];
      if (typeof handler === "function") return handler(cmd?.input);
      return handler ?? {};
    },
  };
}

function buildService(overrides = {}) {
  const cognito = overrides.cognito ?? makeFakeCognito();
  const svc = createUsersService({
    cognito,
    userPoolId: POOL_ID,
    requiredEnv: (n, v) => v,
    httpError,
    commands: cognitoCommands,
  });
  return { cognito, svc };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("toBoolean", () => {
  it("passes through native booleans", () => {
    assert.equal(toBoolean(true), true);
    assert.equal(toBoolean(false), false);
  });
  it("treats numbers: 0 → false, anything else → true", () => {
    assert.equal(toBoolean(0), false);
    assert.equal(toBoolean(1), true);
    assert.equal(toBoolean(-5), true);
  });
  it("parses common string forms (case-insensitive)", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on"]) {
      assert.equal(toBoolean(v), true);
    }
    for (const v of ["false", "FALSE", "0", "no", "off"]) {
      assert.equal(toBoolean(v), false);
    }
  });
  it("falls back on unknown / null / object", () => {
    assert.equal(toBoolean("maybe"), false);
    assert.equal(toBoolean("maybe", true), true);
    assert.equal(toBoolean(null), false);
    assert.equal(toBoolean(undefined, true), true);
    assert.equal(toBoolean({}, true), true);
  });
});

describe("normalizeRole", () => {
  it("returns 'Admin' or 'Staff' verbatim", () => {
    assert.equal(normalizeRole("Admin"), "Admin");
    assert.equal(normalizeRole("Staff"), "Staff");
    assert.equal(normalizeRole(" Admin "), "Admin"); // trims
  });
  it("returns null for any other value (case-sensitive)", () => {
    assert.equal(normalizeRole("admin"), null); // strict case
    assert.equal(normalizeRole("STAFF"), null);
    assert.equal(normalizeRole("Manager"), null);
    assert.equal(normalizeRole(""), null);
    assert.equal(normalizeRole(null), null);
    assert.equal(normalizeRole(undefined), null);
  });
});

describe("MANAGED_GROUPS regression", () => {
  it("is exactly ['Admin', 'Staff'] in this order", () => {
    assert.deepEqual(MANAGED_GROUPS, ["Admin", "Staff"]);
  });
});

describe("mapAttrs", () => {
  it("converts Cognito attribute array to a name-value object", () => {
    const out = mapAttrs([
      { Name: "email", Value: "x@y.com" },
      { Name: "name", Value: "Alice" },
    ]);
    assert.deepEqual(out, { email: "x@y.com", name: "Alice" });
  });
  it("returns {} for null / undefined / empty", () => {
    assert.deepEqual(mapAttrs(null), {});
    assert.deepEqual(mapAttrs(undefined), {});
    assert.deepEqual(mapAttrs([]), {});
  });
  it("skips entries with empty Name", () => {
    const out = mapAttrs([
      { Name: "", Value: "skipped" },
      { Name: "  ", Value: "also skipped" },
      { Name: "ok", Value: "kept" },
    ]);
    assert.deepEqual(out, { ok: "kept" });
  });
  it("coerces Value to string", () => {
    const out = mapAttrs([{ Name: "k", Value: 123 }]);
    assert.deepEqual(out, { k: "123" });
  });
});

describe("mapCognitoUserBase", () => {
  it("infers role: Admin > Staff > User", () => {
    assert.equal(
      mapCognitoUserBase({ Username: "u" }, {}, ["Staff", "Admin"]).role,
      "Admin"
    );
    assert.equal(
      mapCognitoUserBase({ Username: "u" }, {}, ["Staff"]).role,
      "Staff"
    );
    assert.equal(mapCognitoUserBase({ Username: "u" }, {}, []).role, "User");
  });

  it("converts UserCreateDate / UserLastModifiedDate to epoch SECONDS (not ms)", () => {
    const date = new Date("2026-05-09T18:00:00Z");
    const out = mapCognitoUserBase(
      {
        Username: "u",
        UserCreateDate: date,
        UserLastModifiedDate: date,
      },
      {},
      []
    );
    assert.equal(out.createdAt, Math.floor(date.getTime() / 1000));
    assert.equal(out.updatedAt, Math.floor(date.getTime() / 1000));
  });

  it("returns null for missing dates", () => {
    const out = mapCognitoUserBase({ Username: "u" }, {}, []);
    assert.equal(out.createdAt, null);
    assert.equal(out.updatedAt, null);
  });

  it("emailVerified parsed via toBoolean", () => {
    const yes = mapCognitoUserBase({ Username: "u" }, { email_verified: "true" }, []);
    const no = mapCognitoUserBase({ Username: "u" }, { email_verified: "false" }, []);
    const missing = mapCognitoUserBase({ Username: "u" }, {}, []);
    assert.equal(yes.emailVerified, true);
    assert.equal(no.emailVerified, false);
    assert.equal(missing.emailVerified, false);
  });

  it("trims / nulls empty attribute strings", () => {
    const out = mapCognitoUserBase(
      { Username: "u" },
      { name: "  ", email: "", phone_number: " +12025550100 " },
      []
    );
    assert.equal(out.name, null);
    assert.equal(out.email, null);
    assert.equal(out.phone, "+12025550100");
  });

  it("filters empty / whitespace-only group names", () => {
    const out = mapCognitoUserBase(
      { Username: "u" },
      {},
      ["Staff", "", "  ", "Admin"]
    );
    assert.deepEqual(out.groups, ["Staff", "Admin"]);
  });

  it("Enabled: only `true` (literal boolean) maps to true", () => {
    assert.equal(mapCognitoUserBase({ Enabled: true }, {}, []).enabled, true);
    assert.equal(mapCognitoUserBase({ Enabled: "true" }, {}, []).enabled, false);
    assert.equal(mapCognitoUserBase({ Enabled: 1 }, {}, []).enabled, false);
    assert.equal(mapCognitoUserBase({}, {}, []).enabled, false);
  });
});

describe("asHttpError", () => {
  it("maps UsernameExistsException → 409", () => {
    const out = asHttpError(
      Object.assign(new Error("dup"), { name: "UsernameExistsException" }),
      httpError
    );
    assert.equal(out.statusCode, 409);
    assert.match(out.message, /already exists/);
  });
  it("maps UserNotFoundException → 404", () => {
    const out = asHttpError(
      Object.assign(new Error("gone"), { name: "UserNotFoundException" }),
      httpError
    );
    assert.equal(out.statusCode, 404);
  });
  it("maps InvalidParameterException → 400 with original message", () => {
    const out = asHttpError(
      Object.assign(new Error("Bad email format"), { name: "InvalidParameterException" }),
      httpError
    );
    assert.equal(out.statusCode, 400);
    assert.equal(out.message, "Bad email format");
  });
  it("returns the error unchanged for unknown Cognito error codes", () => {
    const orig = Object.assign(new Error("Throttling"), { name: "ThrottlingException" });
    const out = asHttpError(orig, httpError);
    assert.equal(out, orig); // same reference
    assert.equal(out.statusCode, undefined);
  });
});

// ---------------------------------------------------------------------------
// Factory: getUserByUsername
// ---------------------------------------------------------------------------

describe("getUserByUsername", () => {
  it("400 when username is empty", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.getUserByUsername(""),
      (err) => err?.statusCode === 400
    );
  });

  it("fetches Get + groups in parallel and maps the result", async () => {
    const cognito = makeFakeCognito({
      responses: {
        AdminGetUserCommand: () => ({
          Username: "u1",
          Enabled: true,
          UserStatus: "CONFIRMED",
          UserAttributes: [
            { Name: "email", Value: "x@y.com" },
            { Name: "name", Value: "Alice" },
          ],
        }),
        AdminListGroupsForUserCommand: () => ({
          Groups: [{ GroupName: "Staff" }, { GroupName: "Admin" }],
          NextToken: null,
        }),
      },
    });
    const { svc } = buildService({ cognito });
    const out = await svc.getUserByUsername("u1");
    assert.equal(out.username, "u1");
    assert.equal(out.email, "x@y.com");
    assert.equal(out.name, "Alice");
    assert.equal(out.role, "Admin");
    assert.deepEqual(out.groups, ["Staff", "Admin"]);
  });

  it("paginates groups via NextToken", async () => {
    let pageCount = 0;
    const cognito = makeFakeCognito({
      responses: {
        AdminGetUserCommand: () => ({
          Username: "u1",
          Enabled: true,
          UserAttributes: [],
        }),
        AdminListGroupsForUserCommand: () => {
          pageCount += 1;
          if (pageCount === 1) {
            return { Groups: [{ GroupName: "Staff" }], NextToken: "tok-2" };
          }
          if (pageCount === 2) {
            return { Groups: [{ GroupName: "Admin" }], NextToken: null };
          }
          return { Groups: [], NextToken: null };
        },
      },
    });
    const { svc } = buildService({ cognito });
    const out = await svc.getUserByUsername("u1");
    assert.equal(pageCount, 2);
    assert.deepEqual(out.groups.sort(), ["Admin", "Staff"]);
  });

  it("dedups groups across pages", async () => {
    let pageCount = 0;
    const cognito = makeFakeCognito({
      responses: {
        AdminGetUserCommand: () => ({ Username: "u1", UserAttributes: [] }),
        AdminListGroupsForUserCommand: () => {
          pageCount += 1;
          if (pageCount === 1) {
            return { Groups: [{ GroupName: "Staff" }], NextToken: "tok-2" };
          }
          // Same group in second page
          return { Groups: [{ GroupName: "Staff" }], NextToken: null };
        },
      },
    });
    const { svc } = buildService({ cognito });
    const out = await svc.getUserByUsername("u1");
    assert.deepEqual(out.groups, ["Staff"]);
  });

  it("translates UserNotFoundException → 404 via asHttpError", async () => {
    const userNotFound = new Error("gone");
    userNotFound.name = "UserNotFoundException";
    const cognito = makeFakeCognito({
      throwOnCommand: { AdminGetUserCommand: userNotFound },
    });
    const { svc } = buildService({ cognito });
    await assert.rejects(
      () => svc.getUserByUsername("u1"),
      (err) => err?.statusCode === 404
    );
  });
});

// ---------------------------------------------------------------------------
// Factory: listUsers
// ---------------------------------------------------------------------------

describe("listUsers", () => {
  it("clamps limit to [1, 60] (default 50)", async () => {
    const cognito = makeFakeCognito({
      responses: {
        ListUsersCommand: (input) => ({
          Users: [],
          PaginationToken: null,
          // Echo the limit so we can assert it
          _echoLimit: input.Limit,
        }),
      },
    });
    const { svc, cognito: c } = buildService({ cognito });
    await svc.listUsers({ limit: 9999 });
    let call = c.calls.find((x) => x.name === "ListUsersCommand");
    assert.equal(call.input.Limit, 60);

    // Negative non-zero clamps to 1 (it's truthy, so doesn't fall back to 50)
    await svc.listUsers({ limit: -5 });
    call = c.calls.filter((x) => x.name === "ListUsersCommand").at(-1);
    assert.equal(call.input.Limit, 1);

    // 0 / undefined fall back to 50 via the `|| 50` short-circuit
    await svc.listUsers({ limit: 0 });
    call = c.calls.filter((x) => x.name === "ListUsersCommand").at(-1);
    assert.equal(call.input.Limit, 50);

    await svc.listUsers({});
    call = c.calls.filter((x) => x.name === "ListUsersCommand").at(-1);
    assert.equal(call.input.Limit, 50);
  });

  it("returns mapped users + nextToken passthrough", async () => {
    let listCalls = 0;
    let groupCalls = 0;
    const cognito = makeFakeCognito({
      responses: {
        ListUsersCommand: () => {
          listCalls += 1;
          return {
            Users: [
              {
                Username: "u1",
                Enabled: true,
                Attributes: [{ Name: "email", Value: "a@x.com" }],
              },
              {
                Username: "u2",
                Enabled: false,
                Attributes: [{ Name: "email", Value: "b@x.com" }],
              },
            ],
            PaginationToken: "next-page-tok",
          };
        },
        AdminListGroupsForUserCommand: (input) => {
          groupCalls += 1;
          return {
            Groups: [
              { GroupName: input.Username === "u1" ? "Admin" : "Staff" },
            ],
            NextToken: null,
          };
        },
      },
    });
    const { svc } = buildService({ cognito });
    const out = await svc.listUsers({ limit: 10 });
    assert.equal(listCalls, 1);
    assert.equal(groupCalls, 2); // one per user
    assert.equal(out.items.length, 2);
    assert.equal(out.items[0].role, "Admin");
    assert.equal(out.items[1].role, "Staff");
    assert.equal(out.nextToken, "next-page-tok");
  });

  it("nextToken null when PaginationToken empty", async () => {
    const cognito = makeFakeCognito({
      responses: {
        ListUsersCommand: () => ({ Users: [], PaginationToken: "" }),
      },
    });
    const { svc } = buildService({ cognito });
    const out = await svc.listUsers({});
    assert.equal(out.nextToken, null);
  });
});

// ---------------------------------------------------------------------------
// Factory: createUser
// ---------------------------------------------------------------------------

describe("createUser", () => {
  it("400 on missing email", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.createUser({ role: "Admin" }),
      (err) => err?.statusCode === 400 && /email/.test(err.message)
    );
  });

  it("400 on bad role (Manager / lowercase / empty)", async () => {
    const { svc } = buildService();
    for (const role of ["Manager", "admin", "", undefined]) {
      await assert.rejects(
        () => svc.createUser({ email: "x@y.com", role }),
        (err) => err?.statusCode === 400 && /role must be Admin or Staff/.test(err.message)
      );
    }
  });

  it("uses email as username when username missing, lowercases email", async () => {
    const cognito = makeFakeCognito({
      responses: {
        AdminCreateUserCommand: () => ({}),
        AdminAddUserToGroupCommand: () => ({}),
        AdminGetUserCommand: () => ({ Username: "x@y.com", UserAttributes: [] }),
        AdminListGroupsForUserCommand: () => ({ Groups: [], NextToken: null }),
      },
    });
    const { svc } = buildService({ cognito });
    await svc.createUser({ email: "X@Y.COM", role: "Staff" });
    const create = cognito.calls.find((c) => c.name === "AdminCreateUserCommand");
    assert.equal(create.input.Username, "x@y.com");
    assert.deepEqual(
      create.input.UserAttributes.find((a) => a.Name === "email").Value,
      "x@y.com"
    );
    assert.deepEqual(create.input.DesiredDeliveryMediums, ["EMAIL"]);
  });

  it("includes name attribute when provided, omits when blank", async () => {
    const cognito = makeFakeCognito({
      responses: {
        AdminCreateUserCommand: () => ({}),
        AdminAddUserToGroupCommand: () => ({}),
        AdminGetUserCommand: () => ({ Username: "x@y.com", UserAttributes: [] }),
        AdminListGroupsForUserCommand: () => ({ Groups: [], NextToken: null }),
      },
    });
    const { svc } = buildService({ cognito });
    await svc.createUser({ email: "x@y.com", name: "  ", role: "Staff" });
    let call = cognito.calls.find((c) => c.name === "AdminCreateUserCommand");
    assert.ok(!call.input.UserAttributes.find((a) => a.Name === "name"));

    await svc.createUser({ email: "x@y.com", name: "Alice", role: "Staff" });
    call = cognito.calls.filter((c) => c.name === "AdminCreateUserCommand").at(-1);
    assert.equal(call.input.UserAttributes.find((a) => a.Name === "name").Value, "Alice");
  });

  it("adds user to the requested role group, then re-fetches via getUserByUsername", async () => {
    const cognito = makeFakeCognito({
      responses: {
        AdminCreateUserCommand: () => ({}),
        AdminAddUserToGroupCommand: () => ({}),
        AdminGetUserCommand: () => ({
          Username: "x@y.com",
          Enabled: true,
          UserAttributes: [],
        }),
        AdminListGroupsForUserCommand: () => ({
          Groups: [{ GroupName: "Admin" }],
          NextToken: null,
        }),
      },
    });
    const { svc } = buildService({ cognito });
    const out = await svc.createUser({ email: "x@y.com", role: "Admin" });
    const addToGroup = cognito.calls.find((c) => c.name === "AdminAddUserToGroupCommand");
    assert.equal(addToGroup.input.GroupName, "Admin");
    assert.equal(out.role, "Admin");
  });

  it("translates UsernameExistsException → 409", async () => {
    const exists = new Error("dup");
    exists.name = "UsernameExistsException";
    const cognito = makeFakeCognito({
      throwOnCommand: { AdminCreateUserCommand: exists },
    });
    const { svc } = buildService({ cognito });
    await assert.rejects(
      () => svc.createUser({ email: "x@y.com", role: "Staff" }),
      (err) => err?.statusCode === 409
    );
  });
});

// ---------------------------------------------------------------------------
// Factory: updateUserRole
// ---------------------------------------------------------------------------

describe("updateUserRole", () => {
  it("400 on missing username / bad role", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.updateUserRole("", "Admin"),
      (err) => err?.statusCode === 400
    );
    await assert.rejects(
      () => svc.updateUserRole("u1", "Manager"),
      (err) => err?.statusCode === 400
    );
  });

  it("Staff → Admin: removes from Staff, adds to Admin", async () => {
    let pageCount = 0;
    const cognito = makeFakeCognito({
      responses: {
        AdminListGroupsForUserCommand: () => {
          pageCount += 1;
          // First read: current groups = [Staff]. Second read: after the
          // add-to-group, returned to the getUserByUsername call.
          return pageCount === 1
            ? { Groups: [{ GroupName: "Staff" }], NextToken: null }
            : { Groups: [{ GroupName: "Admin" }], NextToken: null };
        },
        AdminRemoveUserFromGroupCommand: () => ({}),
        AdminAddUserToGroupCommand: () => ({}),
        AdminGetUserCommand: () => ({ Username: "u1", UserAttributes: [] }),
      },
    });
    const { svc } = buildService({ cognito });
    const out = await svc.updateUserRole("u1", "Admin");

    const remove = cognito.calls.find((c) => c.name === "AdminRemoveUserFromGroupCommand");
    assert.ok(remove);
    assert.equal(remove.input.GroupName, "Staff");

    const add = cognito.calls.find((c) => c.name === "AdminAddUserToGroupCommand");
    assert.ok(add);
    assert.equal(add.input.GroupName, "Admin");

    assert.equal(out.role, "Admin");
  });

  it("Admin → Admin (no-op): no remove/add (already in Admin, never had Staff)", async () => {
    const cognito = makeFakeCognito({
      responses: {
        AdminListGroupsForUserCommand: () => ({
          Groups: [{ GroupName: "Admin" }],
          NextToken: null,
        }),
        AdminGetUserCommand: () => ({ Username: "u1", UserAttributes: [] }),
      },
    });
    const { svc } = buildService({ cognito });
    await svc.updateUserRole("u1", "Admin");
    assert.equal(
      cognito.calls.filter((c) => c.name === "AdminRemoveUserFromGroupCommand").length,
      0
    );
    assert.equal(
      cognito.calls.filter((c) => c.name === "AdminAddUserToGroupCommand").length,
      0
    );
  });
});

// ---------------------------------------------------------------------------
// Factory: updateUserStatus + resetUserPassword
// ---------------------------------------------------------------------------

describe("updateUserStatus", () => {
  it("400 on missing username", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.updateUserStatus("", true),
      (err) => err?.statusCode === 400
    );
  });

  it("enabled=true → AdminEnableUserCommand", async () => {
    const cognito = makeFakeCognito({
      responses: {
        AdminEnableUserCommand: () => ({}),
        AdminGetUserCommand: () => ({ Username: "u1", UserAttributes: [] }),
        AdminListGroupsForUserCommand: () => ({ Groups: [], NextToken: null }),
      },
    });
    const { svc } = buildService({ cognito });
    await svc.updateUserStatus("u1", true);
    assert.ok(cognito.calls.find((c) => c.name === "AdminEnableUserCommand"));
    assert.ok(!cognito.calls.find((c) => c.name === "AdminDisableUserCommand"));
  });

  it("enabled=false → AdminDisableUserCommand", async () => {
    const cognito = makeFakeCognito({
      responses: {
        AdminDisableUserCommand: () => ({}),
        AdminGetUserCommand: () => ({ Username: "u1", UserAttributes: [] }),
        AdminListGroupsForUserCommand: () => ({ Groups: [], NextToken: null }),
      },
    });
    const { svc } = buildService({ cognito });
    await svc.updateUserStatus("u1", false);
    assert.ok(cognito.calls.find((c) => c.name === "AdminDisableUserCommand"));
    assert.ok(!cognito.calls.find((c) => c.name === "AdminEnableUserCommand"));
  });

  it("string 'true' is parsed as boolean true via toBoolean", async () => {
    const cognito = makeFakeCognito({
      responses: {
        AdminEnableUserCommand: () => ({}),
        AdminGetUserCommand: () => ({ Username: "u1", UserAttributes: [] }),
        AdminListGroupsForUserCommand: () => ({ Groups: [], NextToken: null }),
      },
    });
    const { svc } = buildService({ cognito });
    await svc.updateUserStatus("u1", "true");
    assert.ok(cognito.calls.find((c) => c.name === "AdminEnableUserCommand"));
  });
});

describe("resetUserPassword", () => {
  it("400 on missing username", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.resetUserPassword(""),
      (err) => err?.statusCode === 400
    );
  });

  it("issues AdminResetUserPasswordCommand then re-fetches", async () => {
    const cognito = makeFakeCognito({
      responses: {
        AdminResetUserPasswordCommand: () => ({}),
        AdminGetUserCommand: () => ({ Username: "u1", UserAttributes: [] }),
        AdminListGroupsForUserCommand: () => ({ Groups: [], NextToken: null }),
      },
    });
    const { svc } = buildService({ cognito });
    await svc.resetUserPassword("u1");
    const reset = cognito.calls.find((c) => c.name === "AdminResetUserPasswordCommand");
    assert.ok(reset);
    assert.equal(reset.input.Username, "u1");
  });

  it("translates Cognito errors via asHttpError", async () => {
    const userNotFound = new Error("gone");
    userNotFound.name = "UserNotFoundException";
    const cognito = makeFakeCognito({
      throwOnCommand: { AdminResetUserPasswordCommand: userNotFound },
    });
    const { svc } = buildService({ cognito });
    await assert.rejects(
      () => svc.resetUserPassword("u1"),
      (err) => err?.statusCode === 404
    );
  });
});
