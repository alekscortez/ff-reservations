import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { ReservationsNew } from './reservations-new';

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

describe('ReservationsNew', () => {
  let component: ReservationsNew;
  let fixture: ComponentFixture<ReservationsNew>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReservationsNew],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: of(convertToParamMap({})),
            paramMap: of(convertToParamMap({})),
            snapshot: {
              queryParamMap: convertToParamMap({}),
              paramMap: convertToParamMap({}),
            },
          },
        },
      ],
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
