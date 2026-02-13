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
