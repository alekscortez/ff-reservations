import { decodeJwt, normalizeGroupsClaim } from './jwt';

// Build a base64url-encoded JWT body for the given claims, with optional
// padding-stripped output (Cognito and some IdPs strip trailing '=').
function buildJwt(claims: object, opts: { stripPadding?: boolean } = {}): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), opts);
  const payload = base64url(JSON.stringify(claims), opts);
  const sig = base64url('signature-stub', opts);
  return `${header}.${payload}.${sig}`;
}

function base64url(s: string, opts: { stripPadding?: boolean } = {}): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  let out = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
  if (opts.stripPadding) out = out.replace(/=+$/, '');
  return out;
}

describe('decodeJwt', () => {
  it('returns null for empty / malformed input', () => {
    expect(decodeJwt(null)).toBeNull();
    expect(decodeJwt(undefined)).toBeNull();
    expect(decodeJwt('')).toBeNull();
    expect(decodeJwt('not-a-jwt')).toBeNull();
    expect(decodeJwt('only.two')).toBeNull();
  });

  it('decodes a well-formed token', () => {
    const token = buildJwt({ sub: 'abc', email: 'a@example.com' });
    expect(decodeJwt(token)).toEqual({ sub: 'abc', email: 'a@example.com' });
  });

  it('decodes a token with stripped base64url padding', () => {
    // Pick a payload whose base64 length is not a multiple of 4 so the
    // stripped form would break naive atob().
    const token = buildJwt({ sub: 'aaa', x: 'y' }, { stripPadding: true });
    const claims = decodeJwt(token);
    expect(claims?.['sub']).toBe('aaa');
  });

  it('decodes UTF-8 payload (e.g. accented names) without corruption', () => {
    const token = buildJwt({ name: 'Aleksandría — Cortés' });
    expect(decodeJwt(token)).toEqual({ name: 'Aleksandría — Cortés' });
  });

  it('returns null when the payload is not valid JSON', () => {
    const garbage = `header.${base64url('not json at all')}.sig`;
    expect(decodeJwt(garbage)).toBeNull();
  });
});

describe('normalizeGroupsClaim', () => {
  it('returns [] for missing / empty inputs', () => {
    expect(normalizeGroupsClaim(undefined)).toEqual([]);
    expect(normalizeGroupsClaim(null)).toEqual([]);
    expect(normalizeGroupsClaim('')).toEqual([]);
    expect(normalizeGroupsClaim('   ')).toEqual([]);
  });

  it('passes through a real array', () => {
    expect(normalizeGroupsClaim(['Admin', 'Staff'])).toEqual(['Admin', 'Staff']);
  });

  it('parses a JSON-stringified array (Pre Token Gen v2 access tokens)', () => {
    expect(normalizeGroupsClaim('["Admin","Staff"]')).toEqual(['Admin', 'Staff']);
  });

  it('parses a comma-separated list (legacy or fallback)', () => {
    expect(normalizeGroupsClaim('Admin, Staff')).toEqual(['Admin', 'Staff']);
  });

  it('drops empty entries and trims whitespace', () => {
    expect(normalizeGroupsClaim(['Admin', '', '  Staff  '])).toEqual(['Admin', 'Staff']);
    expect(normalizeGroupsClaim('Admin, , Staff')).toEqual(['Admin', 'Staff']);
  });

  it('returns [] when the JSON-shaped string is not actually an array', () => {
    expect(normalizeGroupsClaim('[not json]')).toEqual(['[not json]']);
    expect(normalizeGroupsClaim('[42]')).toEqual(['42']);
  });

  it('coerces non-string entries inside an array', () => {
    expect(normalizeGroupsClaim([1, 2])).toEqual(['1', '2']);
  });
});
