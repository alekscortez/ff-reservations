import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { Reservations } from './reservations';

describe('Reservations', () => {
  let component: Reservations;
  let fixture: ComponentFixture<Reservations>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Reservations],
      providers: [provideRouter([])],
    })
    .compileComponents();

    fixture = TestBed.createComponent(Reservations);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
