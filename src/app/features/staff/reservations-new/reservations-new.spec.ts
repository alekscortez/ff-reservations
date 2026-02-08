import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ReservationsNew } from './reservations-new';

describe('ReservationsNew', () => {
  let component: ReservationsNew;
  let fixture: ComponentFixture<ReservationsNew>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReservationsNew]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ReservationsNew);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
