import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { HoldsService } from './holds.service';
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
      return of(responses[`GET ${path}`] ?? {});
    },
    post: (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body });
      return of(responses[`POST ${path}`] ?? {});
    },
    delete: (path: string) => {
      calls.push({ method: 'DELETE', path });
      return of(null);
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, HoldsService],
  });
  return { svc: TestBed.inject(HoldsService), calls };
}

describe('HoldsService', () => {
  it('createHold: POST /holds with full payload; unwraps item', async () => {
    const { svc, calls } = setup({ 'POST /holds': { item: { holdId: 'h1' } } });
    const res = await firstValueFrom(
      svc.createHold({
        eventDate: '2026-05-09',
        tableId: 't1',
        customerName: 'A',
        phone: '+1',
        phoneCountry: 'US',
      })
    );
    expect(calls[0].body).toEqual({
      eventDate: '2026-05-09',
      tableId: 't1',
      customerName: 'A',
      phone: '+1',
      phoneCountry: 'US',
    });
    expect(res).toEqual({ holdId: 'h1' });
  });

  it('releaseHold: DELETE /holds/:eventDate/:tableId', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.releaseHold('2026-05-09', 't1'));
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/holds/2026-05-09/t1' });
  });

  it('listLocks: GET /holds with eventDate param; unwraps items', async () => {
    const { svc, calls } = setup({ 'GET /holds': { items: [{ holdId: 'h1' }] } });
    const res = await firstValueFrom(svc.listLocks('2026-05-09'));
    expect(calls[0]).toEqual({ method: 'GET', path: '/holds', params: { eventDate: '2026-05-09' } });
    expect(res).toEqual([{ holdId: 'h1' }]);
  });

  it('listLocks: defaults missing items to []', async () => {
    const { svc } = setup({ 'GET /holds': {} });
    expect(await firstValueFrom(svc.listLocks('2026-05-09'))).toEqual([]);
  });
});
