import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { ReservationsService } from './reservations.service';
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
      return of(responses[`PUT ${path}`] ?? null);
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiClient, useValue: fakeApi }, ReservationsService],
  });
  return { svc: TestBed.inject(ReservationsService), calls };
}

describe('ReservationsService', () => {
  it('create: POST /reservations passes payload through (no defaulting)', async () => {
    const { svc, calls } = setup({ 'POST /reservations': { item: { reservationId: 'r1' } } });
    const payload = {
      eventDate: '2026-05-09',
      tableId: 't1',
      holdId: 'h1',
      customerName: 'A',
      phone: '+1',
      depositAmount: 50,
    };
    const res = await firstValueFrom(svc.create(payload));
    expect(calls[0]).toEqual({ method: 'POST', path: '/reservations', body: payload });
    expect(res).toEqual({ item: { reservationId: 'r1' } });
  });

  it('list: GET /reservations with eventDate; unwraps items[]', async () => {
    const { svc, calls } = setup({ 'GET /reservations': { items: [{ reservationId: 'r1' }] } });
    const res = await firstValueFrom(svc.list('2026-05-09'));
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/reservations',
      params: { eventDate: '2026-05-09' },
    });
    expect(res).toEqual([{ reservationId: 'r1' }]);
  });

  it('list: defaults missing items to []', async () => {
    const { svc } = setup({ 'GET /reservations': {} });
    expect(await firstValueFrom(svc.list('2026-05-09'))).toEqual([]);
  });

  it('cancel: PUT /reservations/:id/cancel with default resolutionType=CANCEL_NO_REFUND', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.cancel('r1', '2026-05-09', 't1', 'no-show'));
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/reservations/r1/cancel',
      body: {
        eventDate: '2026-05-09',
        tableId: 't1',
        cancelReason: 'no-show',
        resolutionType: 'CANCEL_NO_REFUND',
      },
    });
  });

  it('cancel: passes RESCHEDULE_CREDIT and REFUND', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(svc.cancel('r1', '2026-05-09', 't1', 'wx', 'RESCHEDULE_CREDIT'));
    await firstValueFrom(svc.cancel('r2', '2026-05-09', 't2', 'wx', 'REFUND'));
    expect((calls[0].body as any).resolutionType).toBe('RESCHEDULE_CREDIT');
    expect((calls[1].body as any).resolutionType).toBe('REFUND');
  });

  it('addPayment: PUT /reservations/:id/payment with empty-string defaults', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(
      svc.addPayment({
        reservationId: 'r1',
        eventDate: '2026-05-09',
        amount: 25,
        method: 'cash',
      })
    );
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/reservations/r1/payment',
      body: {
        eventDate: '2026-05-09',
        amount: 25,
        method: 'cash',
        creditId: '',
        receiptNumber: '',
        note: '',
      },
    });
  });

  it('addPayment: forwards optional fields when provided', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(
      svc.addPayment({
        reservationId: 'r1',
        eventDate: '2026-05-09',
        amount: 25,
        method: 'credit',
        creditId: 'cred-1',
        receiptNumber: 'RCP-001',
        note: 'paid by check',
      })
    );
    expect(calls[0].body).toEqual({
      eventDate: '2026-05-09',
      amount: 25,
      method: 'credit',
      creditId: 'cred-1',
      receiptNumber: 'RCP-001',
      note: 'paid by check',
    });
  });

  it('addSquarePayment: POST /reservations/:id/payment/square with empty-string defaults', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(
      svc.addSquarePayment({
        reservationId: 'r1',
        eventDate: '2026-05-09',
        amount: 100,
        sourceId: 'src',
      })
    );
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/reservations/r1/payment/square',
      body: { eventDate: '2026-05-09', amount: 100, sourceId: 'src', note: '', idempotencyKey: '' },
    });
  });

  it('createSquarePaymentLink: POST /reservations/:id/payment-link/square', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(
      svc.createSquarePaymentLink({ reservationId: 'r1', eventDate: '2026-05-09', amount: 50 })
    );
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/reservations/r1/payment-link/square',
      body: { eventDate: '2026-05-09', amount: 50, note: '', idempotencyKey: '' },
    });
  });

  it('createSquarePaymentLinkSms: POST /reservations/:id/payment-link/square/sms', async () => {
    const { svc, calls } = setup();
    await firstValueFrom(
      svc.createSquarePaymentLinkSms({ reservationId: 'r1', eventDate: '2026-05-09' })
    );
    expect(calls[0].path).toBe('/reservations/r1/payment-link/square/sms');
    expect(calls[0].body).toEqual({
      eventDate: '2026-05-09',
      amount: undefined,
      note: '',
      idempotencyKey: '',
    });
  });

  it('listHistory: GET /reservations/:id/history with eventDate; unwraps items', async () => {
    const { svc, calls } = setup({ 'GET /reservations/r1/history': { items: [{ at: 1 }] } });
    const res = await firstValueFrom(svc.listHistory('r1', '2026-05-09'));
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/reservations/r1/history',
      params: { eventDate: '2026-05-09' },
    });
    expect(res).toEqual([{ at: 1 }]);
  });

  it('listHistory: defaults missing items to []', async () => {
    const { svc } = setup({ 'GET /reservations/r1/history': {} });
    expect(await firstValueFrom(svc.listHistory('r1', '2026-05-09'))).toEqual([]);
  });
});
