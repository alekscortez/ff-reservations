// Tests for the Pre Token Generation v2 Lambda. This trigger is what
// makes cognito:groups appear in ACCESS tokens (Cognito populates it on
// ID tokens by default but NOT on access tokens). Without this Lambda
// working correctly, every authenticated request to /admin/* and
// /staff/* silently 403s with "Admin/Staff required".

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handler } from "./index.mjs";

function makeEvent(groupsToOverride) {
  return {
    request: {
      groupConfiguration: { groupsToOverride },
    },
    response: {},
  };
}

describe("pre-token-gen handler", () => {
  it("emits cognito:groups as a JSON-stringified array on the access token", async () => {
    const event = makeEvent(["Admin", "Staff"]);
    const out = await handler(event);
    const claim = out.response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride["cognito:groups"];
    // **Critical**: must be a JSON string (v2 trigger requires string values).
    // The backend's getGroupsFromEvent parses both JSON-string and bare-string forms.
    assert.equal(typeof claim, "string");
    assert.deepEqual(JSON.parse(claim), ["Admin", "Staff"]);
  });

  it("emits empty array '[]' when groupsToOverride is missing/empty", async () => {
    for (const event of [makeEvent([]), makeEvent(undefined), { request: {}, response: {} }]) {
      const out = await handler(event);
      const claim = out.response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride["cognito:groups"];
      assert.equal(claim, "[]");
    }
  });

  it("trims whitespace + drops empty group names", async () => {
    const event = makeEvent([" Admin ", "", "  ", "Staff"]);
    const out = await handler(event);
    const claim = out.response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride["cognito:groups"];
    assert.deepEqual(JSON.parse(claim), ["Admin", "Staff"]);
  });

  it("coerces non-string entries via String()", async () => {
    const event = makeEvent([123, true, null]);
    const out = await handler(event);
    const claim = out.response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride["cognito:groups"];
    // 123 → "123" (kept), true → "true" (kept), null → "" (dropped by filter(Boolean))
    assert.deepEqual(JSON.parse(claim), ["123", "true"]);
  });

  it("**does NOT override idTokenGeneration** (cognito:groups stays as native array on ID token)", async () => {
    const event = makeEvent(["Admin"]);
    const out = await handler(event);
    // Important regression: the frontend reads ID-token cognito:groups as
    // a real array via the OIDC client. If we accidentally overrode the
    // idTokenGeneration claims with a JSON string, the frontend's
    // groups.includes('Admin') would always be false (string includes
    // works on substrings).
    assert.equal(
      out.response.claimsAndScopeOverrideDetails.idTokenGeneration,
      undefined
    );
  });

  it("preserves the original event keys (spreads ...event)", async () => {
    const event = makeEvent(["Admin"]);
    event.userPoolId = "us-east-1_test"; // arbitrary input field
    event.userName = "alice@x.com";
    const out = await handler(event);
    assert.equal(out.userPoolId, "us-east-1_test");
    assert.equal(out.userName, "alice@x.com");
  });
});
