import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { EventsService } from '../../../core/http/events.service';
import { ReservationsService } from '../../../core/http/reservations.service';
import { TablesService } from '../../../core/http/tables.service';

import { Dashboard } from './dashboard';

describe('Dashboard', () => {
  let component: Dashboard;
  let fixture: ComponentFixture<Dashboard>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [
        provideRouter([]),
        {
          provide: EventsService,
          useValue: {
            getEventByDate: () => of({ eventId: '1', eventName: 'Tonight', eventDate: '2026-02-14', status: 'ACTIVE', minDeposit: 0 }),
            listEvents: () => of([]),
            getCurrentContext: () =>
              of({
                businessDate: '2026-02-14',
                event: null,
                nextEvent: null,
                operatingTz: 'America/Chicago',
                operatingDayCutoffHour: 5,
                settings: {
                  operatingTz: 'America/Chicago',
                  operatingDayCutoffHour: 5,
                  defaultPaymentDeadlineHour: 0,
                  defaultPaymentDeadlineMinute: 0,
                  rescheduleCutoffHour: 22,
                  rescheduleCutoffMinute: 0,
                  dashboardPollingSeconds: 15,
                  tableAvailabilityPollingSeconds: 10,
                  clientAvailabilityPollingSeconds: 15,
                  urgentPaymentWindowMinutes: 360,
                  showClientFacingMap: false,
                },
              }),
          },
        },
        {
          provide: TablesService,
          useValue: {
            getForEvent: () =>
              of({
                event: { eventId: '1', eventName: 'Tonight', eventDate: '2026-02-14', status: 'ACTIVE', minDeposit: 0 },
                tables: [],
              }),
          },
        },
        {
          provide: ReservationsService,
          useValue: {
            list: () => of([]),
            listRecentAcrossEvents: () => of([]),
            addPayment: () =>
              of({
                item: {
                  reservationId: 'r1',
                  eventDate: '2026-02-14',
                  tableId: 'A01',
                  customerName: 'Test',
                  phone: '0000000000',
                  depositAmount: 100,
                  amountDue: 100,
                  paymentStatus: 'PAID',
                  status: 'CONFIRMED',
                },
              }),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Dashboard);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
