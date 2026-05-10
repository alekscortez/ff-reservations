import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { SettingsService } from './settings.service';
import { ApiClient } from './api-client';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function setup(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fakeApi = {
    get: (path: string) => {
      calls.push({ method: 'GET', path });
      return of(responses[`GET ${path}`] ?? {});
    },
    put: (path: string, body?: unknown) => {
      calls.push({ method: 'PUT', path, body });
      return of(responses[`PUT ${path}`] ?? {});
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, SettingsService],
  });
  return { svc: TestBed.inject(SettingsService), calls };
}

describe('SettingsService', () => {
  it('getAdminSettings: GET /admin/settings; unwraps item', async () => {
    const settings = { operatingTz: 'America/Chicago', operatingDayCutoffHour: 4 };
    const { svc, calls } = setup({ 'GET /admin/settings': { item: settings } });
    expect(await firstValueFrom(svc.getAdminSettings())).toBe(settings);
    expect(calls[0].path).toBe('/admin/settings');
  });

  it('updateAdminSettings: PUT /admin/settings with patch; unwraps item', async () => {
    const updated = { operatingTz: 'America/Mexico_City' } as any;
    const { svc, calls } = setup({ 'PUT /admin/settings': { item: updated } });
    const res = await firstValueFrom(svc.updateAdminSettings({ operatingTz: 'America/Mexico_City' } as any));
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/admin/settings',
      body: { operatingTz: 'America/Mexico_City' },
    });
    expect(res).toBe(updated);
  });
});
