import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { UsersService } from './users.service';
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
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, UsersService],
  });
  return { svc: TestBed.inject(UsersService), calls };
}

describe('UsersService', () => {
  it('list: defaults limit=50, omits nextToken when not provided', async () => {
    const { svc, calls } = setup({ 'GET /admin/users': { items: [{ username: 'u' }], nextToken: null } });
    const res = await firstValueFrom(svc.list());
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/admin/users',
      params: { limit: 50 },
    });
    expect(res).toEqual({ items: [{ username: 'u' }], nextToken: null });
  });

  it('list: includes nextToken when provided', async () => {
    const { svc, calls } = setup({ 'GET /admin/users': { items: [], nextToken: 'tok-2' } });
    const res = await firstValueFrom(svc.list(25, 'tok-1'));
    expect(calls[0].params).toEqual({ limit: 25, nextToken: 'tok-1' });
    expect(res.nextToken).toBe('tok-2');
  });

  it('list: defaults items+nextToken to []/null on missing fields', async () => {
    const { svc } = setup({ 'GET /admin/users': {} });
    expect(await firstValueFrom(svc.list())).toEqual({ items: [], nextToken: null });
  });

  it('create: POST /admin/users; unwraps item', async () => {
    const { svc, calls } = setup({ 'POST /admin/users': { item: { username: 'u' } } });
    const res = await firstValueFrom(svc.create({ email: 'x@y.com', name: 'X', role: 'Staff' }));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/admin/users',
      body: { email: 'x@y.com', name: 'X', role: 'Staff' },
    });
    expect(res).toEqual({ username: 'u' });
  });

  it('updateRole: PUT /admin/users/:username/role (URL-encoded); unwraps item', async () => {
    const { svc, calls } = setup({
      'PUT /admin/users/x%40y.com/role': { item: { username: 'x@y.com', role: 'Admin' } },
    });
    const res = await firstValueFrom(svc.updateRole('x@y.com', 'Admin'));
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/admin/users/x%40y.com/role', // @ encoded
      body: { role: 'Admin' },
    });
    expect(res).toEqual({ username: 'x@y.com', role: 'Admin' });
  });

  it('updateStatus: PUT /admin/users/:username/status; unwraps item', async () => {
    const { svc, calls } = setup({
      'PUT /admin/users/u/status': { item: { username: 'u', enabled: false } },
    });
    await firstValueFrom(svc.updateStatus('u', false));
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/admin/users/u/status',
      body: { enabled: false },
    });
  });

  it('resetPassword: POST /admin/users/:username/reset-password with empty body', async () => {
    const { svc, calls } = setup({
      'POST /admin/users/u/reset-password': { ok: true, message: 'ok', item: { username: 'u' } },
    });
    const res = await firstValueFrom(svc.resetPassword('u'));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/admin/users/u/reset-password',
      body: {},
    });
    expect(res.ok).toBe(true);
  });
});
