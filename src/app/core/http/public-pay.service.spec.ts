import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { PublicPayService } from './public-pay.service';
import { ApiClient } from './api-client';

interface Call {
  method: string;
  path: string;
  body?: unknown;
  params?: unknown;
}

function setup() {
  const calls: Call[] = [];
  const fakeApi = {
    get: (path: string, params?: unknown) => {
      calls.push({ method: 'GET', path, params });
      return of({});
    },
    post: (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body });
      return of({});
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, PublicPayService],
  });
  return { svc: TestBed.inject(PublicPayService), calls };
}

describe('PublicPayService', () => {
  it('getSession: GET /cashapp/session with eventDate, reservationId, token', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.getSession('2026-05-09', 'r1', 'tok'));
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/cashapp/session',
      params: { eventDate: '2026-05-09', reservationId: 'r1', token: 'tok' },
    });
  });

  it('charge: POST /cashapp/session/charge with full payload + idempotencyKey default ""', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(
      svc.charge({
        eventDate: '2026-05-09',
        reservationId: 'r1',
        token: 'tok',
        sourceId: 'src',
      })
    );
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/cashapp/session/charge',
      body: {
        eventDate: '2026-05-09',
        reservationId: 'r1',
        token: 'tok',
        sourceId: 'src',
        idempotencyKey: '',
      },
    });
  });

  it('charge: passes idempotencyKey when provided', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(
      svc.charge({
        eventDate: '2026-05-09',
        reservationId: 'r1',
        token: 'tok',
        sourceId: 'src',
        idempotencyKey: 'idem-1',
      })
    );
    expect((calls[0].body as any).idempotencyKey).toBe('idem-1');
  });
});
