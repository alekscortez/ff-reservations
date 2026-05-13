import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, Subject, of } from 'rxjs';
import { vi } from 'vitest';

import {
  PublicAvailabilityResponse,
  PublicAvailabilityService,
} from '../../../core/http/public-availability.service';
import { PublicAvailability } from './availability';

function makeResponse(
  overrides: Partial<PublicAvailabilityResponse> = {}
): PublicAvailabilityResponse {
  return {
    event: {
      eventId: 'e1',
      eventDate: '2026-05-09',
      eventName: 'Friday',
      status: 'ACTIVE',
    },
    businessDate: '2026-05-09',
    asOfEpoch: 1_700_000_000,
    counts: { total: 2, available: 1, unavailable: 1 },
    refreshSeconds: 10,
    events: [],
    tables: [
      { id: 'A01', number: 1, section: 'A', price: 100, status: 'AVAILABLE', available: true },
      { id: 'A02', number: 2, section: 'A', price: 100, status: 'UNAVAILABLE', available: false },
    ],
    ...overrides,
  };
}

interface PendingCall {
  eventDate: string | undefined;
  subject: Subject<PublicAvailabilityResponse>;
}

function makeFakeApi() {
  const calls: PendingCall[] = [];
  const fake = {
    getAvailability(eventDate?: string): Observable<PublicAvailabilityResponse> {
      const subject = new Subject<PublicAvailabilityResponse>();
      calls.push({ eventDate, subject });
      return subject.asObservable();
    },
  } as unknown as PublicAvailabilityService;
  return { calls, fake };
}

async function setup(opts?: { initialQuery?: Record<string, string> }) {
  const { calls, fake } = makeFakeApi();
  await TestBed.configureTestingModule({
    imports: [PublicAvailability],
    providers: [
      provideRouter([]),
      { provide: PublicAvailabilityService, useValue: fake },
      {
        provide: ActivatedRoute,
        useValue: {
          queryParamMap: of(convertToParamMap(opts?.initialQuery ?? {})),
          paramMap: of(convertToParamMap({})),
          snapshot: {
            queryParamMap: convertToParamMap(opts?.initialQuery ?? {}),
            paramMap: convertToParamMap({}),
          },
        },
      },
    ],
  }).compileComponents();
  const fixture: ComponentFixture<PublicAvailability> = TestBed.createComponent(PublicAvailability);
  fixture.detectChanges(); // runs ngOnInit → first loadAvailability
  return { fixture, component: fixture.componentInstance, calls };
}

describe('PublicAvailability', () => {
  it('renders empty-state and Clear filters button when filtered list is empty', async () => {
    const { fixture, component, calls } = await setup();
    expect(calls).toHaveLength(1);

    // Resolve with all-unavailable tables — default availableOnly=true → 0 results
    calls[0].subject.next(
      makeResponse({
        tables: [
          { id: 'A01', number: 1, section: 'A', price: 100, status: 'UNAVAILABLE', available: false },
          { id: 'A02', number: 2, section: 'A', price: 100, status: 'UNAVAILABLE', available: false },
        ],
      })
    );
    component.setViewMode('LIST');
    fixture.detectChanges();

    // Two aria-live regions exist (Updated stamp + empty-state) — pick the
    // one carrying the empty-state copy.
    const regions = Array.from(
      fixture.nativeElement.querySelectorAll('[aria-live="polite"]')
    ) as HTMLElement[];
    const empty = regions.find((el) =>
      (el.textContent ?? '').includes('No tables match your filter')
    );
    expect(empty).toBeTruthy();
    const clearBtn = empty!.querySelector('button');
    expect(clearBtn?.textContent ?? '').toContain('Clear filters');
  });

  it('clearFilters resets search + availableOnly so all tables become visible again', async () => {
    const { fixture, component, calls } = await setup();
    calls[0].subject.next(makeResponse());
    fixture.detectChanges();

    component.search.setValue('zzz'); // matches nothing
    expect(component.hasNoFilteredTables()).toBe(true);
    expect(component.hasActiveFilter()).toBe(true);

    component.clearFilters();
    expect(component.search.value).toBe('');
    expect(component.availableOnly.value).toBe(false);
    expect(component.hasNoFilteredTables()).toBe(false);
    expect(component.hasActiveFilter()).toBe(false);
  });

  it('retryLoad fires a new API call even after an error', async () => {
    const { component, calls } = await setup();
    expect(calls).toHaveLength(1);

    calls[0].subject.error(new Error('boom'));
    expect(component.error()).toBe('boom');

    component.retryLoad();
    expect(calls).toHaveLength(2);
    calls[1].subject.next(makeResponse());
    expect(component.error()).toBeNull();
    expect(component.data()).not.toBeNull();
  });

  it('cancels in-flight load before issuing a new one (rapid date toggle keeps only the latest)', async () => {
    const { fixture, component, calls } = await setup();
    expect(calls).toHaveLength(1);

    // Fire a second load (simulates rapid date toggle) before the first responds
    component.retryLoad();
    expect(calls).toHaveLength(2);

    // Late response from the FIRST (stale) call should not flip data
    calls[0].subject.next(
      makeResponse({ event: { eventId: 'stale', eventDate: '2099-01-01', eventName: 'Stale', status: 'ACTIVE' } })
    );
    fixture.detectChanges();
    expect(component.data()).toBeNull();

    // Resolve the LATEST call → data should reflect that
    calls[1].subject.next(makeResponse({ event: { eventId: 'fresh', eventDate: '2026-05-15', eventName: 'Fresh', status: 'ACTIVE' } }));
    expect(component.data()?.event.eventId).toBe('fresh');
  });

  it('arms polling after first-call error and recovers when a polled tick succeeds', async () => {
    vi.useFakeTimers();
    try {
      const { fixture, component, calls } = await setup();
      expect(calls).toHaveLength(1);

      calls[0].subject.error(new Error('first call failed'));
      expect(component.error()).toContain('first call failed');

      // Default polling interval is 10s — advance past it to fire a silent retry
      vi.advanceTimersByTime(10_000);
      expect(calls).toHaveLength(2);

      calls[1].subject.next(makeResponse());
      expect(component.error()).toBeNull();
      expect(component.data()).not.toBeNull();

      fixture.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
