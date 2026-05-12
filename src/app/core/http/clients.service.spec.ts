import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { ClientsService } from './clients.service';
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
    put: (path: string, body?: unknown) => {
      calls.push({ method: 'PUT', path, body });
      return of(responses[`PUT ${path}`] ?? {});
    },
    delete: (path: string) => {
      calls.push({ method: 'DELETE', path });
      return of(responses[`DELETE ${path}`] ?? null);
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, ClientsService],
  });
  return { svc: TestBed.inject(ClientsService), calls };
}

describe('ClientsService', () => {
  it('list: GET /clients; unwraps items[]', async () => {
    const { svc, calls } = setup({
      'GET /clients': { items: [{ phone: '+1', name: 'A' }] },
    });
    const res = await firstValueFrom(svc.list());
    expect(calls).toEqual([{ method: 'GET', path: '/clients', params: undefined }]);
    expect(res).toEqual([{ phone: '+1', name: 'A' }]);
  });

  it('list: defaults missing items to []', async () => {
    const { svc } = setup({ 'GET /clients': {} });
    expect(await firstValueFrom(svc.list())).toEqual([]);
  });

  it('update: PUT /clients/:phone (URL-encoded); unwraps item', async () => {
    const { svc, calls } = setup({
      'PUT /clients/%2B1234567890': { item: { phone: '+1234567890', name: 'X' } },
    });
    const res = await firstValueFrom(svc.update('+1234567890', { name: 'X' }));
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/clients/%2B1234567890', // encodeURIComponent on the +
      body: { name: 'X' },
    });
    expect(res).toEqual({ phone: '+1234567890', name: 'X' });
  });

  it('delete: DELETE /clients/:phone (URL-encoded)', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.delete('+1 555/0'));
    // Forward slash and space must be encoded — the path mustn't be parsed
    // by the backend as additional segments.
    expect(calls[0].path).toBe('/clients/%2B1%20555%2F0');
  });

  it('searchByPhone: GET /clients/search with phone param', async () => {
    const { svc, calls } = setup({ 'GET /clients/search': { items: [{ phone: '+1' }] } });
    const res = await firstValueFrom(svc.searchByPhone('+1'));
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/clients/search',
      params: { phone: '+1' },
    });
    expect(res).toEqual([{ phone: '+1' }]);
  });

  it('searchByName: GET /clients/search with q param; unwraps items', async () => {
    const { svc, calls } = setup({
      'GET /clients/search': { items: [{ phone: '+19564147489', name: 'Julio Torres' }] },
    });
    const res = await firstValueFrom(svc.searchByName('julio'));
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/clients/search',
      params: { q: 'julio' },
    });
    expect(res).toEqual([{ phone: '+19564147489', name: 'Julio Torres' }]);
  });

  it('searchByName: defaults missing items to []', async () => {
    const { svc } = setup({ 'GET /clients/search': {} });
    expect(await firstValueFrom(svc.searchByName('xyz'))).toEqual([]);
  });

  it('listRescheduleCredits: defaults phoneCountry to "US"', async () => {
    const { svc, calls } = setup({ 'GET /clients/credits': { items: [] } });
    await firstValueFrom(svc.listRescheduleCredits('+1'));
    expect(calls[0].params).toEqual({ phone: '+1', phoneCountry: 'US' });
  });

  it('listRescheduleCredits: passes through phoneCountry "MX"', async () => {
    const { svc, calls } = setup({ 'GET /clients/credits': { items: [] } });
    await firstValueFrom(svc.listRescheduleCredits('+52', 'MX'));
    expect(calls[0].params).toEqual({ phone: '+52', phoneCountry: 'MX' });
  });
});
