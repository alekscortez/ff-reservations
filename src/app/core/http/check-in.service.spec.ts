import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { CheckInService } from './check-in.service';
import { ApiClient } from './api-client';

interface Call {
  method: string;
  path: string;
  body?: unknown;
  params?: unknown;
}

function setup(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fakeApi = {
    get: (path: string, params?: unknown) => {
      calls.push({ method: 'GET', path, params });
      return of(responses[`GET ${path}`] ?? { issued: false, reused: false, pass: null });
    },
    post: (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body });
      return of(responses[`POST ${path}`] ?? { issued: false, reused: false, pass: null });
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, CheckInService],
  });
  return { svc: TestBed.inject(CheckInService), calls };
}

describe('CheckInService', () => {
  it('getReservationPass: GET /reservations/:id/check-in-pass with eventDate param', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.getReservationPass('r1', '2026-05-09'));
    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/reservations/r1/check-in-pass',
        params: { eventDate: '2026-05-09' },
      },
    ]);
  });

  it('issueReservationPass: POST with reissue=false default', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.issueReservationPass('r1', '2026-05-09'));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/reservations/r1/check-in-pass',
      body: { eventDate: '2026-05-09', reissue: false },
    });
  });

  it('issueReservationPass: POST with reissue=true', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.issueReservationPass('r1', '2026-05-09', true));
    expect(calls[0].body).toEqual({ eventDate: '2026-05-09', reissue: true });
  });

  it('verifyToken: POST /check-in/verify with token + scannerDevice; unwraps result', async () => {
    const { svc, calls } = setup({
      'POST /check-in/verify': { result: { ok: true, code: 'CHECKED_IN', message: 'ok' } },
    });
    const res = await firstValueFrom(svc.verifyToken('tok-abc', 'scanner-1'));
    expect(calls[0].body).toEqual({ token: 'tok-abc', scannerDevice: 'scanner-1' });
    expect(res).toEqual({ ok: true, code: 'CHECKED_IN', message: 'ok' });
  });

  it('verifyToken: defaults scannerDevice to empty string', async () => {
    const { svc, calls } = setup({
      'POST /check-in/verify': { result: { ok: false } },
    });
    await firstValueFrom(svc.verifyToken('tok'));
    expect(calls[0].body).toEqual({ token: 'tok', scannerDevice: '' });
  });

  it('verifyToken: handles missing result field defensively (returns undefined)', async () => {
    // Backend should always wrap in {result: …} but the optional chain in the
    // service shouldn't throw if it ever ships a bare body.
    const { svc } = setup({ 'POST /check-in/verify': null });
    const res = await firstValueFrom(svc.verifyToken('tok'));
    expect(res).toBeUndefined();
  });
});
