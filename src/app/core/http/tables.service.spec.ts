import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { TablesService } from './tables.service';
import { ApiClient } from './api-client';

interface Call {
  method: string;
  path: string;
}

function setup(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fakeApi = {
    get: (path: string) => {
      calls.push({ method: 'GET', path });
      return of(responses[`GET ${path}`] ?? {});
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, TablesService],
  });
  return { svc: TestBed.inject(TablesService), calls };
}

describe('TablesService', () => {
  it('getTemplate: GET /tables/template; unwraps template', async () => {
    const template = { tables: [], sections: ['A'] } as any;
    const { svc, calls } = setup({ 'GET /tables/template': { template } });
    expect(await firstValueFrom(svc.getTemplate())).toBe(template);
    expect(calls[0].path).toBe('/tables/template');
  });

  it('getForEvent: GET /tables/for-event/:eventDate (no unwrap)', async () => {
    const payload = { event: { eventId: 'e1' }, tables: [] } as any;
    const { svc, calls } = setup({ 'GET /tables/for-event/2026-05-09': payload });
    const res = await firstValueFrom(svc.getForEvent('2026-05-09'));
    expect(calls[0].path).toBe('/tables/for-event/2026-05-09');
    expect(res).toBe(payload);
  });
});
