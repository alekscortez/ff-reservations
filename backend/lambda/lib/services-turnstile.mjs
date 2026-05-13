// Cloudflare Turnstile token verification for the public anonymous-booking
// endpoint. Frontend renders the widget with a site key (read from settings
// + emitted on /public/availability), user solves the challenge, widget
// hands back a single-use token, frontend forwards it to POST
// /public/reservations, this verifier hits Cloudflare's siteverify endpoint
// to confirm the token + secret pair is real and the token hasn't been
// replayed.
//
// Failure modes:
// - Token replayed / expired → success=false, errorCodes contains
//   `timeout-or-duplicate` or `invalid-input-response`. Caller should 403.
// - Network failure to challenges.cloudflare.com → fail closed (throw 503).
//   Better to show "couldn't verify, try again" than to silently let a
//   bot through because Cloudflare had a hiccup.
// - secret missing / blank → throw 500. Means deploy is misconfigured.

const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function createTurnstileService({
  fetchImpl = globalThis.fetch,
  httpError,
  // Lets tests stub Date.now()-derived telemetry; defaults to no-op.
  logger = console,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("createTurnstileService: fetchImpl is required");
  }

  // Verify a Turnstile response token. Returns {success, errorCodes,
  // hostname, challengeTs} on a network round-trip; throws on infra
  // failure or missing secret. Never throws on a *bad token* (returns
  // success=false instead) — that's the caller's policy decision.
  async function verifyTurnstileToken({ token, secret, remoteIp }) {
    const tokenStr = String(token ?? "").trim();
    const secretStr = String(secret ?? "").trim();
    if (!secretStr) {
      throw httpError(500, "TURNSTILE secret is not configured");
    }
    if (!tokenStr) {
      return { success: false, errorCodes: ["missing-input-response"] };
    }

    const form = new URLSearchParams();
    form.set("secret", secretStr);
    form.set("response", tokenStr);
    if (remoteIp) form.set("remoteip", String(remoteIp).trim());

    let res;
    try {
      res = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (err) {
      logger.warn?.("turnstile_verify_network_error", {
        message: String(err?.message ?? err ?? ""),
      });
      throw httpError(503, "Could not reach Turnstile verifier");
    }

    if (!res.ok) {
      logger.warn?.("turnstile_verify_http_error", { status: res.status });
      throw httpError(503, "Turnstile verifier returned non-2xx");
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      logger.warn?.("turnstile_verify_parse_error", {
        message: String(err?.message ?? err ?? ""),
      });
      throw httpError(503, "Turnstile verifier returned invalid JSON");
    }

    return {
      success: Boolean(body?.success),
      errorCodes: Array.isArray(body?.["error-codes"])
        ? body["error-codes"].map((v) => String(v))
        : [],
      hostname: typeof body?.hostname === "string" ? body.hostname : "",
      challengeTs:
        typeof body?.challenge_ts === "string" ? body.challenge_ts : "",
    };
  }

  return { verifyTurnstileToken };
}
