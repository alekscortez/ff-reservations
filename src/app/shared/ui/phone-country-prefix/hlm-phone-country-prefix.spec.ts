import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  HlmPhoneCountryPrefix,
  type PhoneCountryCode,
} from './hlm-phone-country-prefix';

@Component({
  standalone: true,
  imports: [HlmPhoneCountryPrefix],
  template: `
    <hlm-phone-country-prefix
      [country]="country()"
      [disabled]="disabled()"
      (countryChange)="onChange($event)"
    />
  `,
})
class Host {
  country = signal<PhoneCountryCode>('US');
  disabled = signal(false);
  emitted: PhoneCountryCode[] = [];
  onChange(next: PhoneCountryCode) {
    this.emitted.push(next);
    this.country.set(next);
  }
}

function createHost() {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture;
}

async function nextTick() {
  await Promise.resolve();
  await Promise.resolve();
}

async function openMenu(fixture: ReturnType<typeof createHost>) {
  const trigger = (fixture.nativeElement as HTMLElement).querySelector(
    'button[aria-label^="Country code"]',
  ) as HTMLButtonElement;
  trigger.click();
  fixture.detectChanges();
  await nextTick();
  fixture.detectChanges();
}

describe('HlmPhoneCountryPrefix', () => {
  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  it('renders the trigger with the US flag + chevron by default', () => {
    const fixture = createHost();
    const root = fixture.nativeElement as HTMLElement;
    const trigger = root.querySelector(
      'button[aria-label^="Country code"]',
    ) as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('aria-label')).toContain('United States');
    const flagImg = trigger.querySelector('img') as HTMLImageElement | null;
    expect(flagImg?.getAttribute('src')).toBe('assets/flags/us.svg');
    // Chevron is the only ng-icon inside the trigger
    expect(trigger.querySelector('ng-icon')).toBeTruthy();
  });

  it('switches the flag + aria-label when country input changes', () => {
    const fixture = createHost();
    fixture.componentInstance.country.set('MX');
    fixture.detectChanges();
    const trigger = (fixture.nativeElement as HTMLElement).querySelector(
      'button[aria-label^="Country code"]',
    ) as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toContain('Mexico');
    const flagImg = trigger.querySelector('img') as HTMLImageElement;
    expect(flagImg.getAttribute('src')).toBe('assets/flags/mx.svg');
  });

  it('opens a menu with both country options when the trigger is tapped', async () => {
    const fixture = createHost();
    await openMenu(fixture);

    const items = document.querySelectorAll('[hlmMenu] button[hlmMenuItem]');
    expect(items).toHaveLength(2);
    // First row = US, second = MX (component preserves declaration order)
    expect(items[0].textContent).toContain('+1');
    expect(items[0].textContent).toContain('United States');
    expect(items[1].textContent).toContain('+52');
    expect(items[1].textContent).toContain('Mexico');
  });

  it('shows the check icon only on the currently-selected row', async () => {
    const fixture = createHost();
    await openMenu(fixture);

    const items = document.querySelectorAll('[hlmMenu] button[hlmMenuItem]');
    // Default = US → row 0 has the chevron+check, row 1 only has the flag
    const row0Icons = (items[0] as HTMLElement).querySelectorAll('ng-icon');
    const row1Icons = (items[1] as HTMLElement).querySelectorAll('ng-icon');
    expect(row0Icons.length).toBe(1); // the check
    expect(row1Icons.length).toBe(0);
  });

  it('emits countryChange and updates aria-label when the OTHER row is tapped', async () => {
    const fixture = createHost();
    await openMenu(fixture);

    const mxBtn = document.querySelectorAll(
      '[hlmMenu] button[hlmMenuItem]',
    )[1] as HTMLButtonElement;
    mxBtn.click();
    fixture.detectChanges();
    await nextTick();

    expect(fixture.componentInstance.emitted).toEqual(['MX']);
    // Trigger reflects the new selection (host's signal binding)
    fixture.detectChanges();
    const trigger = (fixture.nativeElement as HTMLElement).querySelector(
      'button[aria-label^="Country code"]',
    ) as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toContain('Mexico');
  });

  it('does NOT emit when the currently-active row is tapped (no-op)', async () => {
    const fixture = createHost();
    await openMenu(fixture);

    const usBtn = document.querySelectorAll(
      '[hlmMenu] button[hlmMenuItem]',
    )[0] as HTMLButtonElement;
    usBtn.click();
    fixture.detectChanges();
    await nextTick();

    expect(fixture.componentInstance.emitted).toEqual([]);
  });

  it('disables the trigger button when [disabled] is true', () => {
    const fixture = createHost();
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();
    const trigger = (fixture.nativeElement as HTMLElement).querySelector(
      'button[aria-label^="Country code"]',
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });
});
