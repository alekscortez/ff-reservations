// Cognito Pre Token Generation v2 trigger.
//
// Cognito populates `cognito:groups` in ID tokens by default, but NOT in
// access tokens. This app's API Gateway authorizer + Lambda code rely on
// `cognito:groups` being present in the ACCESS token (see the auth model
// notes in CLAUDE.md). Without this trigger, every authenticated request
// to /admin/* and /staff/* silently 403s with "Admin/Staff privileges
// required".
//
// Trigger configuration (Cognito console → User pool → User pool properties
//   → Lambda triggers → Pre token generation):
//   - Trigger event version: V2_0 (token customization for access tokens)
//   - Lambda function: ff-reservations-pre-token-gen
//
// Deployment lives in this folder's README.md.

export const handler = async (event) => {
  const groups = Array.isArray(event?.request?.groupConfiguration?.groupsToOverride)
    ? event.request.groupConfiguration.groupsToOverride
        .map((g) => String(g ?? "").trim())
        .filter(Boolean)
    : [];

  // The backend's getGroupsFromEvent (backend/lambda/index.mjs:127) accepts
  // both arrays and JSON-string arrays. v2 triggers require string values
  // in claimsToAddOrOverride, so we JSON-stringify for the access token.
  //
  // We deliberately do NOT override idTokenGeneration: Cognito already
  // populates cognito:groups on ID tokens as a native string array, and
  // overriding here would clobber that with a JSON string and break any
  // consumer that expects an array (the frontend reads ID-token claims
  // directly in auth-callback.ts and auth.service.ts).
  const groupsClaim = JSON.stringify(groups);

  return {
    ...event,
    response: {
      claimsAndScopeOverrideDetails: {
        accessTokenGeneration: {
          claimsToAddOrOverride: {
            "cognito:groups": groupsClaim,
          },
        },
      },
    },
  };
};
