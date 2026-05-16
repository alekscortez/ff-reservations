import {
  Attribution,
  captureAttribution,
  getAttribution,
  _clearAttributionForTests,
} from './attribution';

describe('attribution', () => {
  beforeEach(() => {
    _clearAttributionForTests();
    // Reset URL between tests using jsdom's history API.
    window.history.replaceState({}, '', '/');
  });

  function setUrl(path: string): void {
    window.history.replaceState({}, '', path);
  }

  it('returns null when no params present and nothing stored', () => {
    setUrl('/reserva');
    expect(captureAttribution()).toBeNull();
    expect(getAttribution()).toBeNull();
  });

  it('captures utm params on first touch', () => {
    setUrl('/reserva?utm_source=meta&utm_medium=paid&utm_campaign=launch_week');
    const snap = captureAttribution();
    expect(snap?.utm_source).toBe('meta');
    expect(snap?.utm_medium).toBe('paid');
    expect(snap?.utm_campaign).toBe('launch_week');
    expect(snap?.firstTouchAt).toEqual(expect.any(Number));
  });

  it('captures fbclid and gclid', () => {
    setUrl('/reserva?fbclid=ABC123&gclid=XYZ789');
    const snap = captureAttribution();
    expect(snap?.fbclid).toBe('ABC123');
    expect(snap?.gclid).toBe('XYZ789');
  });

  it('records landingPath from the URL pathname', () => {
    setUrl('/reserva?utm_source=meta');
    const snap = captureAttribution();
    expect(snap?.landingPath).toBe('/reserva');
  });

  it('FIRST-TOUCH WINS — second call with different utm does not overwrite', () => {
    setUrl('/reserva?utm_source=meta&utm_campaign=launch');
    const first = captureAttribution();
    expect(first?.utm_source).toBe('meta');

    setUrl('/reserva?utm_source=google&utm_campaign=brand');
    const second = captureAttribution();
    expect(second?.utm_source).toBe('meta'); // unchanged
    expect(second?.utm_campaign).toBe('launch'); // unchanged
  });

  it('persists across reads (localStorage roundtrip)', () => {
    setUrl('/reserva?utm_source=meta&fbclid=ABC');
    captureAttribution();
    setUrl('/reserva'); // navigate away from the tagged URL
    const recovered = getAttribution();
    expect(recovered?.utm_source).toBe('meta');
    expect(recovered?.fbclid).toBe('ABC');
  });

  it('ignores empty / whitespace param values', () => {
    setUrl('/reserva?utm_source=&utm_medium=%20%20&utm_campaign=launch');
    const snap = captureAttribution();
    expect(snap?.utm_source).toBeUndefined();
    expect(snap?.utm_medium).toBeUndefined();
    expect(snap?.utm_campaign).toBe('launch');
  });

  it('caps individual values at 200 chars (DDOS / spam guard)', () => {
    const huge = 'x'.repeat(500);
    setUrl(`/reserva?utm_source=${huge}`);
    const snap = captureAttribution();
    expect(snap?.utm_source?.length).toBe(200);
  });

  it('ignores keys outside the whitelist', () => {
    setUrl('/reserva?utm_source=meta&malicious=<script>alert(1)</script>');
    const snap = captureAttribution() as Attribution & { malicious?: string };
    expect(snap?.utm_source).toBe('meta');
    expect(snap?.malicious).toBeUndefined();
  });
});
