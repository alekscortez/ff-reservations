const MANAGED_GROUPS = ["Admin", "Staff"];

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeRole(rawRole) {
  const role = String(rawRole ?? "").trim();
  if (role === "Admin" || role === "Staff") return role;
  return null;
}

function mapAttrs(attrs) {
  const out = {};
  for (const attr of attrs ?? []) {
    const key = String(attr?.Name ?? "").trim();
    if (!key) continue;
    out[key] = String(attr?.Value ?? "");
  }
  return out;
}

function mapCognitoUserBase(raw, attrs, groups) {
  const groupNames = (groups ?? [])
    .map((g) => String(g ?? "").trim())
    .filter(Boolean);
  return {
    username: String(raw?.Username ?? "").trim() || null,
    enabled: raw?.Enabled === true,
    status: String(raw?.UserStatus ?? "").trim() || null,
    createdAt: raw?.UserCreateDate
      ? Math.floor(new Date(raw.UserCreateDate).getTime() / 1000)
      : null,
    updatedAt: raw?.UserLastModifiedDate
      ? Math.floor(new Date(raw.UserLastModifiedDate).getTime() / 1000)
      : null,
    name: String(attrs?.name ?? "").trim() || null,
    email: String(attrs?.email ?? "").trim() || null,
    phone: String(attrs?.phone_number ?? "").trim() || null,
    emailVerified: toBoolean(attrs?.email_verified, false),
    groups: groupNames,
    role: groupNames.includes("Admin")
      ? "Admin"
      : groupNames.includes("Staff")
        ? "Staff"
        : "User",
  };
}

function asHttpError(err, httpError) {
  const code = String(err?.name ?? "");
  if (code === "UsernameExistsException") return httpError(409, "User already exists");
  if (code === "UserNotFoundException") return httpError(404, "User not found");
  if (code === "InvalidParameterException") {
    return httpError(400, err?.message || "Invalid request");
  }
  return err;
}

export function createUsersService({
  cognito,
  userPoolId,
  requiredEnv,
  httpError,
  commands,
}) {
  const poolId = requiredEnv("USER_POOL_ID", userPoolId);
  const {
    AdminCreateUserCommand,
    AdminAddUserToGroupCommand,
    AdminRemoveUserFromGroupCommand,
    AdminEnableUserCommand,
    AdminDisableUserCommand,
    AdminResetUserPasswordCommand,
    AdminListGroupsForUserCommand,
    ListUsersCommand,
    AdminGetUserCommand,
  } = commands;

  async function listGroupsForUser(username) {
    let token = null;
    const groups = [];
    do {
      const res = await cognito.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: poolId,
          Username: username,
          NextToken: token || undefined,
          Limit: 60,
        })
      );
      groups.push(...(res?.Groups ?? []).map((g) => g?.GroupName).filter(Boolean));
      token = String(res?.NextToken ?? "").trim() || null;
    } while (token);
    return [...new Set(groups)];
  }

  async function getUserByUsername(username) {
    const normalizedUsername = String(username ?? "").trim();
    if (!normalizedUsername) throw httpError(400, "username is required");
    try {
      const [userRes, groups] = await Promise.all([
        cognito.send(
          new AdminGetUserCommand({
            UserPoolId: poolId,
            Username: normalizedUsername,
          })
        ),
        listGroupsForUser(normalizedUsername),
      ]);
      const attrs = mapAttrs(userRes?.UserAttributes ?? []);
      return mapCognitoUserBase(
        {
          Username: userRes?.Username,
          Enabled: userRes?.Enabled,
          UserStatus: userRes?.UserStatus,
          UserCreateDate: userRes?.UserCreateDate,
          UserLastModifiedDate: userRes?.UserLastModifiedDate,
        },
        attrs,
        groups
      );
    } catch (err) {
      throw asHttpError(err, httpError);
    }
  }

  async function listUsers({ limit, nextToken } = {}) {
    try {
      const boundedLimit = Math.max(1, Math.min(60, Number(limit) || 50));
      const res = await cognito.send(
        new ListUsersCommand({
          UserPoolId: poolId,
          Limit: boundedLimit,
          PaginationToken: nextToken || undefined,
        })
      );
      const users = res?.Users ?? [];
      const items = await Promise.all(
        users.map(async (user) => {
          const username = String(user?.Username ?? "").trim();
          const groups = username ? await listGroupsForUser(username) : [];
          const attrs = mapAttrs(user?.Attributes ?? []);
          return mapCognitoUserBase(user, attrs, groups);
        })
      );
      return {
        items,
        nextToken: String(res?.PaginationToken ?? "").trim() || null,
      };
    } catch (err) {
      throw asHttpError(err, httpError);
    }
  }

  async function createUser(payload) {
    const email = String(payload?.email ?? "").trim().toLowerCase();
    const username = String(payload?.username ?? email).trim().toLowerCase();
    const name = String(payload?.name ?? "").trim();
    const role = normalizeRole(payload?.role);

    if (!email) throw httpError(400, "email is required");
    if (!username) throw httpError(400, "username is required");
    if (!role) throw httpError(400, "role must be Admin or Staff");

    const attrs = [{ Name: "email", Value: email }];
    if (name) attrs.push({ Name: "name", Value: name });

    try {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: username,
          UserAttributes: attrs,
          DesiredDeliveryMediums: ["EMAIL"],
        })
      );

      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: poolId,
          Username: username,
          GroupName: role,
        })
      );

      return await getUserByUsername(username);
    } catch (err) {
      throw asHttpError(err, httpError);
    }
  }

  async function updateUserRole(username, nextRole) {
    const normalizedUsername = String(username ?? "").trim();
    if (!normalizedUsername) throw httpError(400, "username is required");
    const role = normalizeRole(nextRole);
    if (!role) throw httpError(400, "role must be Admin or Staff");

    try {
      const currentGroups = await listGroupsForUser(normalizedUsername);

      for (const group of MANAGED_GROUPS) {
        if (group === role) continue;
        if (!currentGroups.includes(group)) continue;
        await cognito.send(
          new AdminRemoveUserFromGroupCommand({
            UserPoolId: poolId,
            Username: normalizedUsername,
            GroupName: group,
          })
        );
      }

      if (!currentGroups.includes(role)) {
        await cognito.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: poolId,
            Username: normalizedUsername,
            GroupName: role,
          })
        );
      }

      return await getUserByUsername(normalizedUsername);
    } catch (err) {
      throw asHttpError(err, httpError);
    }
  }

  async function updateUserStatus(username, enabled) {
    const normalizedUsername = String(username ?? "").trim();
    if (!normalizedUsername) throw httpError(400, "username is required");

    try {
      if (toBoolean(enabled, false)) {
        await cognito.send(
          new AdminEnableUserCommand({
            UserPoolId: poolId,
            Username: normalizedUsername,
          })
        );
      } else {
        await cognito.send(
          new AdminDisableUserCommand({
            UserPoolId: poolId,
            Username: normalizedUsername,
          })
        );
      }

      return await getUserByUsername(normalizedUsername);
    } catch (err) {
      throw asHttpError(err, httpError);
    }
  }

  async function resetUserPassword(username) {
    const normalizedUsername = String(username ?? "").trim();
    if (!normalizedUsername) throw httpError(400, "username is required");

    try {
      await cognito.send(
        new AdminResetUserPasswordCommand({
          UserPoolId: poolId,
          Username: normalizedUsername,
        })
      );
      return await getUserByUsername(normalizedUsername);
    } catch (err) {
      throw asHttpError(err, httpError);
    }
  }

  return {
    listUsers,
    createUser,
    updateUserRole,
    updateUserStatus,
    resetUserPassword,
    getUserByUsername,
  };
}
