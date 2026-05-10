import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { PublicAvailabilityService } from './public-availability.service';
import { ApiClient } from './api-client';

interface Call {
  method: string;
  path: string;
  body?: unknown;
  params?: unknown;
}

function setup(response: unknown = { event: null, businessDate: null, asOfEpoch: 0, counts: { total: 0, available: 0, unavailable: 0 }, refreshSeconds: 30, events: [], tables: [] }) {
  const calls: Call[] = [];
  const fakeApi = {
    get: (path: string, params?: unknown) => {
      calls.push({ method: 'GET', path, params });
      return of(response);
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, PublicAvailabilityService],
  });
  return { svc: TestBed.inject(PublicAvailabilityService), calls };
}

describe('PublicAvailabilityService', () => {
  it('getAvailability: GET /public/availability with eventDate when provided', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.getAvailability('2026-05-09'));
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/public/availability',
      params: { eventDate: '2026-05-09' },
    });
  });

  it('getAvailability: passes undefined eventDate when omitted (lets backend pick today)', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.getAvailability());
    expect(calls[0].params).toEqual({ eventDate: undefined });
  });

  it('getAvailability: passes undefined when empty string is given (server picks today)', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.getAvailability(''));
    // The service does `eventDate || undefined` so empty-string collapses to undefined.
    expect(calls[0].params).toEqual({ eventDate: undefined });
  });
});
