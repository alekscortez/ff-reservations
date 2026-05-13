import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmCalendar, HlmCalendarRange } from './hlm-calendar';

@Component({
  standalone: true,
  imports: [HlmCalendar],
  template: `<hlm-calendar [(date)]="picked" [min]="min" [max]="max" />`,
})
class SingleHost {
  picked = signal<Date | undefined>(new Date(2026, 4, 15));
  min: Date | undefined = undefined;
  max: Date | undefined = undefined;
}

@Component({
  standalone: true,
  imports: [HlmCalendarRange],
  template: `<hlm-calendar-range [(startDate)]="start" [(endDate)]="end" />`,
})
class RangeHost {
  start = signal<Date | undefined>(new Date(2026, 4, 10));
  end = signal<Date | undefined>(new Date(2026, 4, 20));
}

function setupSingle(initial?: Partial<SingleHost>) {
  TestBed.configureTestingModule({ imports: [SingleHost] });
  const fixture = TestBed.createComponent(SingleHost);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function setupRange(initial?: Partial<RangeHost>) {
  TestBed.configureTestingModule({ imports: [RangeHost] });
  const fixture = TestBed.createComponent(RangeHost);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function dayButtons(fixture: any): HTMLButtonElement[] {
  return Array.from(fixture.nativeElement.querySelectorAll('button[brnCalendarCellButton]'));
}

function header(fixture: any): string {
  return fixture.nativeElement.querySelector('[brnCalendarHeader]')?.textContent?.trim() ?? '';
}

function weekdayLabels(fixture: any): string[] {
  return Array.from(fixture.nativeElement.querySelectorAll('[brnCalendarWeekday], span[aria-hidden="true"]'))
    .filter((el: any) => el.classList?.contains('tracking-wide'))
    .map((el: any) => el.textContent?.trim() ?? '');
}

describe('HlmCalendar (single date)', () => {
  it('renders the formatted month/year header for the focused date', () => {
    const f = setupSingle();
    expect(header(f)).toMatch(/May.*2026/i);
  });

  it('renders 7 weekday labels (Sun..Sat by default)', () => {
    const f = setupSingle();
    const labels = weekdayLabels(f);
    expect(labels.length).toBe(7);
    expect(labels[0].toLowerCase()).toContain('su');
  });

  it('renders a 6-week grid (42 day cells) for the focused month', () => {
    const f = setupSingle();
    expect(dayButtons(f).length).toBe(42);
  });

  it('clicking a day cell updates the [(date)] model', () => {
    const f = setupSingle();
    const buttons = dayButtons(f);
    const target = buttons.find((b) => b.textContent?.trim() === '7');
    expect(target).toBeTruthy();
    target!.click();
    f.detectChanges();
    const picked = f.componentInstance.picked();
    expect(picked).toBeInstanceOf(Date);
    expect(picked!.getDate()).toBe(7);
  });

  it('selected day gets the primary background class', () => {
    const f = setupSingle();
    const buttons = dayButtons(f);
    const selected = buttons.find((b) => b.textContent?.trim() === '15');
    expect(selected?.className).toContain('bg-primary');
  });

  it('min/max bounds disable out-of-range cells', () => {
    const f = setupSingle({
      min: new Date(2026, 4, 10),
      max: new Date(2026, 4, 20),
    });
    const buttons = dayButtons(f);
    const earlyMay = buttons.find((b) => b.textContent?.trim() === '5');
    const lateMay = buttons.find((b) => b.textContent?.trim() === '25');
    expect(earlyMay?.className).toContain('opacity-40');
    expect(lateMay?.className).toContain('opacity-40');
  });
});

describe('HlmCalendarRange', () => {
  it('marks the start cell with rounded-l and primary bg', () => {
    const f = setupRange();
    const buttons = dayButtons(f);
    const startCell = buttons.find((b) => b.textContent?.trim() === '10');
    expect(startCell?.className).toContain('bg-primary');
    expect(startCell?.className).toContain('rounded-l-md');
  });

  it('marks the end cell with rounded-r and primary bg', () => {
    const f = setupRange();
    const buttons = dayButtons(f);
    const endCell = buttons.find((b) => b.textContent?.trim() === '20');
    expect(endCell?.className).toContain('bg-primary');
    expect(endCell?.className).toContain('rounded-r-md');
  });

  it('marks between-range cells with the tinted background', () => {
    const f = setupRange();
    const buttons = dayButtons(f);
    const between = buttons.find((b) => b.textContent?.trim() === '15');
    expect(between?.className).toContain('bg-primary/10');
  });

  it('clicking a third date after start+end resets to a new start', () => {
    const f = setupRange();
    const buttons = dayButtons(f);
    const newStart = buttons.find((b) => b.textContent?.trim() === '25');
    newStart!.click();
    f.detectChanges();
    expect(f.componentInstance.start()?.getDate()).toBe(25);
    expect(f.componentInstance.end()).toBeUndefined();
  });
});
