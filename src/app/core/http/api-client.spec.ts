import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { ApiClient } from './api-client';
import { APP_CONFIG } from '../config/app-config';

const BASE = APP_CONFIG.apiBaseUrl;

function ticks(ms: number): Promise<void> {
  // The retry uses RxJS timer(200) which schedules via the asyncScheduler.
  // The cleanest way to "advance time" without diving into vi fake timers
  // (which interact awkwardly with HttpTestingController) is to wait the
  // real ~200ms. Tests still finish in <1s and the retry path is short.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ApiClient', () => {
  let api: ApiClient;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ApiClient],
    });
    api = TestBed.inject(ApiClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  describe('URL composition', () => {
    it('prepends apiBaseUrl to GET path', () => {
      api.get('/widgets').subscribe();
      const req = http.expectOne(`${BASE}/widgets`);
      req.flush({ items: [] });
    });

    it('prepends apiBaseUrl to POST/PUT/DELETE', () => {
      api.post('/x', { a: 1 }).subscribe();
      api.put('/y', { b: 2 }).subscribe();
      api.delete('/z').subscribe();
      http.expectOne((r) => r.method === 'POST' && r.url === `${BASE}/x`).flush({});
      http.expectOne((r) => r.method === 'PUT' && r.url === `${BASE}/y`).flush({});
      http.expectOne((r) => r.method === 'DELETE' && r.url === `${BASE}/z`).flush({});
    });
  });

  describe('toParams (private — exercised via verb wrappers)', () => {
    it('serializes string, number, boolean — coerces non-string via String()', () => {
      api.get('/q', { name: 'a', count: 5, on: true }).subscribe();
      const req = http.expectOne((r) => r.url === `${BASE}/q`);
      // HttpParams API: get() returns string or null
      expect(req.request.params.get('name')).toBe('a');
      expect(req.request.params.get('count')).toBe('5');
      expect(req.request.params.get('on')).toBe('true');
      req.flush({});
    });

    it('drops null and undefined values', () => {
      api.get('/q', { keep: 'x', skipNull: null, skipUndef: undefined }).subscribe();
      const req = http.expectOne((r) => r.url === `${BASE}/q`);
      expect(req.request.params.get('keep')).toBe('x');
      expect(req.request.params.has('skipNull')).toBe(false);
      expect(req.request.params.has('skipUndef')).toBe(false);
      req.flush({});
    });

    it('omits the params object entirely when no params provided', () => {
      api.get('/q').subscribe();
      const req = http.expectOne((r) => r.url === `${BASE}/q`);
      expect(req.request.params.keys().length).toBe(0);
      req.flush({});
    });

    it('passes params on POST/PUT/DELETE too', () => {
      api.post('/x', { body: 1 }, { p: 'v' }).subscribe();
      api.put('/y', { body: 2 }, { p: 'v' }).subscribe();
      api.delete('/z', { p: 'v' }).subscribe();
      for (const r of http.match(() => true)) {
        expect(r.request.params.get('p')).toBe('v');
        r.flush({});
      }
    });
  });

  describe('retry policy (GET only, transient errors only)', () => {
    it('GET retries once on 5xx then succeeds', async () => {
      const result: Array<unknown> = [];
      api.get('/r').subscribe({ next: (v) => result.push(v) });
      const first = http.expectOne(`${BASE}/r`);
      first.flush('boom', { status: 503, statusText: 'Service Unavailable' });

      await ticks(220);

      const second = http.expectOne(`${BASE}/r`);
      second.flush({ ok: true });
      expect(result).toEqual([{ ok: true }]);
    });

    it('GET retries once on status 0 (network/CORS) then succeeds', async () => {
      const result: Array<unknown> = [];
      api.get('/r').subscribe({ next: (v) => result.push(v) });
      http.expectOne(`${BASE}/r`).error(new ProgressEvent('error'), { status: 0, statusText: '' });

      await ticks(220);

      http.expectOne(`${BASE}/r`).flush({ ok: 'recovered' });
      expect(result).toEqual([{ ok: 'recovered' }]);
    });

    it('GET does NOT retry on 4xx (non-transient)', async () => {
      const errors: Array<unknown> = [];
      api.get('/r').subscribe({ error: (e) => errors.push(e) });
      http.expectOne(`${BASE}/r`).flush('nope', { status: 404, statusText: 'Not Found' });
      // Wait past the retry-window; no second request should be issued.
      await ticks(250);
      http.expectNone(`${BASE}/r`);
      expect(errors.length).toBe(1);
    });

    it('GET fails permanently after one retry that also 5xxs', async () => {
      const errors: Array<unknown> = [];
      api.get('/r').subscribe({ error: (e) => errors.push(e) });
      http.expectOne(`${BASE}/r`).flush('boom1', { status: 500, statusText: 'Err' });
      await ticks(220);
      http.expectOne(`${BASE}/r`).flush('boom2', { status: 500, statusText: 'Err' });
      // No third attempt.
      await ticks(250);
      http.expectNone(`${BASE}/r`);
      expect(errors.length).toBe(1);
    });

    it('POST does NOT retry on 5xx (state-mutating verb)', async () => {
      const errors: Array<unknown> = [];
      api.post('/r', { a: 1 }).subscribe({ error: (e) => errors.push(e) });
      http.expectOne(`${BASE}/r`).flush('boom', { status: 503, statusText: 'Err' });
      await ticks(250);
      http.expectNone(`${BASE}/r`);
      expect(errors.length).toBe(1);
    });

    it('PUT does NOT retry on 5xx', async () => {
      const errors: Array<unknown> = [];
      api.put('/r', { a: 1 }).subscribe({ error: (e) => errors.push(e) });
      http.expectOne(`${BASE}/r`).flush('boom', { status: 502, statusText: 'Err' });
      await ticks(250);
      http.expectNone(`${BASE}/r`);
      expect(errors.length).toBe(1);
    });

    it('DELETE does NOT retry on 5xx', async () => {
      const errors: Array<unknown> = [];
      api.delete('/r').subscribe({ error: (e) => errors.push(e) });
      http.expectOne(`${BASE}/r`).flush('boom', { status: 500, statusText: 'Err' });
      await ticks(250);
      http.expectNone(`${BASE}/r`);
      expect(errors.length).toBe(1);
    });
  });
});
