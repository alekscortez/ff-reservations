import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { EventsService } from './events.service';
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
    put: (path: string, body?: unknown) => {
      calls.push({ method: 'PUT', path, body });
      return of(responses[`PUT ${path}`] ?? {});
    },
    delete: (path: string) => {
      calls.push({ method: 'DELETE', path });
      return of(null);
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, EventsService],
  });
  return { svc: TestBed.inject(EventsService), calls };
}

describe('EventsService', () => {
  it('listEvents: GET /events; unwraps items[]', async () => {
    const { svc, calls } = setup({ 'GET /events': { items: [{ eventId: 'e1' }] } });
    const res = await firstValueFrom(svc.listEvents());
    expect(calls[0]).toEqual({ method: 'GET', path: '/events', params: undefined });
    expect(res).toEqual([{ eventId: 'e1' }]);
  });

  it('listEvents: defaults missing items to []', async () => {
    const { svc } = setup({ 'GET /events': {} });
    expect(await firstValueFrom(svc.listEvents())).toEqual([]);
  });

  it('createEvent: POST /events; unwraps item', async () => {
    const { svc, calls } = setup({ 'POST /events': { item: { eventId: 'new' } } });
    const payload = { eventName: 'X', eventDate: '2026-05-09' } as any;
    const res = await firstValueFrom(svc.createEvent(payload));
    expect(calls[0]).toEqual({ method: 'POST', path: '/events', body: payload });
    expect(res).toEqual({ eventId: 'new' });
  });

  it('getEventByDate: GET /events/by-date/:date; unwraps item', async () => {
    const { svc, calls } = setup({ 'GET /events/by-date/2026-05-09': { item: { eventId: 'e1' } } });
    const res = await firstValueFrom(svc.getEventByDate('2026-05-09'));
    expect(calls[0].path).toBe('/events/by-date/2026-05-09');
    expect(res).toEqual({ eventId: 'e1' });
  });

  it('getCurrentContext: GET /events/context/current (no unwrap)', async () => {
    const ctx = { businessDate: '2026-05-09', event: null, nextEvent: null, settings: {} as any, operatingTz: 'America/Chicago', operatingDayCutoffHour: 4 };
    const { svc } = setup({ 'GET /events/context/current': ctx });
    const res = await firstValueFrom(svc.getCurrentContext());
    expect(res).toBe(ctx);
  });

  it('updateEvent: PUT /events/:id with patch; unwraps item', async () => {
    const { svc, calls } = setup({ 'PUT /events/e1': { item: { eventId: 'e1', eventName: 'New' } } });
    const res = await firstValueFrom(svc.updateEvent('e1', { eventName: 'New' }));
    expect(calls[0]).toEqual({ method: 'PUT', path: '/events/e1', body: { eventName: 'New' } });
    expect(res).toEqual({ eventId: 'e1', eventName: 'New' });
  });

  it('deleteEvent: DELETE /events/:id', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.deleteEvent('e1'));
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/events/e1' });
  });
});
