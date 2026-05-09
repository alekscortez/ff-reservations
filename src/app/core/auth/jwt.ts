// Shared JWT decode + group-claim normalization for the OIDC flow.
//
// Two reasons this helper exists:
// 1. atob() requires base64 with padding, but Cognito tokens use base64url
//    and may strip trailing `=`. We pad before decoding.
// 2. The Pre Token Generation v2 trigger writes claims as strings only, so
//    cognito:groups in the access token is a JSON-stringified array. The
//    ID token (when not overridden by the trigger) is a real array. Callers
//    must accept both shapes; normalizeGroupsClaim does that.

export type JwtClaims = Record<string, unknown>;

export function decodeJwt(token: string | null | undefined): JwtClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = base64UrlToString(parts[1]);
  if (payload === null) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? (parsed as JwtClaims) : null;
  } catch {
    return null;
  }
}

export function normalizeGroupsClaim(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((g) => String(g ?? '').trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  const raw = value.trim();
  if (!raw) return [];
  // Cognito's Pre Token Gen v2 stringifies arrays. Try JSON first.
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((g) => String(g ?? '').trim()).filter(Boolean);
      }
    } catch {
      // Fall through to comma-split.
    }
  }
  return raw.split(',').map((g) => g.trim()).filter(Boolean);
}

function base64UrlToString(input: string): string | null {
  try {
    let s = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad === 2) s += '==';
    else if (pad === 3) s += '=';
    else if (pad !== 0) return null;
    const binary = atob(s);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}
