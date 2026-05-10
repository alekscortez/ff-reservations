import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { FrequentClientsService } from './frequent-clients.service';
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
    providers: [{ provide: ApiClient, useValue: fakeApi }, FrequentClientsService],
  });
  return { svc: TestBed.inject(FrequentClientsService), calls };
}

describe('FrequentClientsService', () => {
  it('list: GET /frequent-clients; unwraps items', async () => {
    const { svc, calls } = setup({ 'GET /frequent-clients': { items: [{ clientId: 'c1' }] } });
    expect(await firstValueFrom(svc.list())).toEqual([{ clientId: 'c1' }]);
    expect(calls[0].path).toBe('/frequent-clients');
  });

  it('list: defaults missing items to []', async () => {
    const { svc } = setup({ 'GET /frequent-clients': {} });
    expect(await firstValueFrom(svc.list())).toEqual([]);
  });

  it('create: POST /frequent-clients; unwraps item', async () => {
    const { svc, calls } = setup({ 'POST /frequent-clients': { item: { clientId: 'c1' } } });
    const payload = { name: 'A', phone: '+1' } as any;
    expect(await firstValueFrom(svc.create(payload))).toEqual({ clientId: 'c1' });
    expect(calls[0].body).toEqual(payload);
  });

  it('update: PUT /frequent-clients/:id; unwraps item', async () => {
    const { svc, calls } = setup({ 'PUT /frequent-clients/c1': { item: { clientId: 'c1', name: 'X' } } });
    const res = await firstValueFrom(svc.update('c1', { name: 'X' } as any));
    expect(calls[0]).toEqual({ method: 'PUT', path: '/frequent-clients/c1', body: { name: 'X' } });
    expect(res).toEqual({ clientId: 'c1', name: 'X' });
  });

  it('get: GET /frequent-clients/:id; unwraps item', async () => {
    const { svc, calls } = setup({ 'GET /frequent-clients/c1': { item: { clientId: 'c1' } } });
    expect(await firstValueFrom(svc.get('c1'))).toEqual({ clientId: 'c1' });
    expect(calls[0].path).toBe('/frequent-clients/c1');
  });

  it('delete: DELETE /frequent-clients/:id', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.delete('c1'));
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/frequent-clients/c1' });
  });
});
