import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { AdminService } from './admin.service';
import { ApiClient } from './api-client';

describe('AdminService', () => {
  let admin: AdminService;
  let calls: { method: string; path: string; body?: unknown; params?: unknown }[];

  beforeEach(() => {
    calls = [];
    const fakeApi = {
      get: (path: string, params?: unknown) => {
        calls.push({ method: 'GET', path, params });
        return of({ sub: 'abc', role: 'Admin' });
      },
    };
    TestBed.configureTestingModule({
      providers: [{ provide: ApiClient, useValue: fakeApi }, AdminService],
    });
    admin = TestBed.inject(AdminService);
  });

  it('whoami() GETs /admin/whoami', async () => {
    const res = await firstValueFrom(admin.whoami());
    expect(calls).toEqual([{ method: 'GET', path: '/admin/whoami', params: undefined }]);
    expect(res).toEqual({ sub: 'abc', role: 'Admin' });
  });
});
