import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { EventsService } from '../../../core/http/events.service';
import { ReservationsService } from '../../../core/http/reservations.service';

import { Financials } from './financials';

describe('Financials', () => {
  let component: Financials;
  let fixture: ComponentFixture<Financials>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Financials],
      providers: [
        provideRouter([]),
        {
          provide: EventsService,
          useValue: {
            listEvents: () => of([]),
          },
        },
        {
          provide: ReservationsService,
          useValue: {
            list: () => of([]),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Financials);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
