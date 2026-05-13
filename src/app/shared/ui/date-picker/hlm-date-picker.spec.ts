import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmDatePicker } from './hlm-date-picker';
import { HlmDateRangePicker } from './hlm-date-range-picker';

@Component({
  standalone: true,
  imports: [HlmDatePicker],
  template: `<hlm-date-picker [(date)]="picked" [placeholder]="placeholder" [format]="format" />`,
})
class SingleHost {
  picked = signal<Date | undefined>(undefined);
  placeholder = 'Pick a date';
  format: (d: Date) => string = (d) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

@Component({
  standalone: true,
  imports: [HlmDateRangePicker],
  template: `
    <hlm-date-range-picker
      [(startDate)]="start"
      [(endDate)]="end"
      [placeholder]="placeholder"
      [openEndedLabel]="openEnded"
    />
  `,
})
class RangeHost {
  start = signal<Date | undefined>(undefined);
  end = signal<Date | undefined>(undefined);
  placeholder = 'Select date range';
  openEnded = 'Open';
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

function triggerLabel(fixture: any): string {
  return (
    fixture.nativeElement.querySelector('button[brnPopoverTrigger] span')?.textContent?.trim() ?? ''
  );
}

describe('HlmDatePicker (single)', () => {
  it('renders placeholder when no date is set', () => {
    const f = setupSingle({ placeholder: 'Pick something' });
    expect(triggerLabel(f)).toBe('Pick something');
  });

  it('renders the formatted date when set', () => {
    const f = setupSingle();
    f.componentInstance.picked.set(new Date(2026, 4, 13));
    f.detectChanges();
    expect(triggerLabel(f)).toMatch(/May.*13.*2026/);
  });

  it('uses the custom format function', () => {
    const f = setupSingle({
      format: (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    });
    f.componentInstance.picked.set(new Date(2026, 4, 13));
    f.detectChanges();
    expect(triggerLabel(f)).toBe('2026-05-13');
  });

  it('placeholder gets muted styling (text-brand-400)', () => {
    const f = setupSingle();
    const span = f.nativeElement.querySelector('button[brnPopoverTrigger] span');
    expect(span?.className).toContain('text-brand-400');
  });

  it('selected date drops the muted styling', () => {
    const f = setupSingle();
    f.componentInstance.picked.set(new Date(2026, 4, 13));
    f.detectChanges();
    const span = f.nativeElement.querySelector('button[brnPopoverTrigger] span');
    expect(span?.className).not.toContain('text-brand-400');
  });
});

describe('HlmDateRangePicker', () => {
  it('shows placeholder when nothing is set', () => {
    const f = setupRange({ placeholder: 'Pick a range' });
    expect(triggerLabel(f)).toBe('Pick a range');
  });

  it('formats start + end when both set', () => {
    const f = setupRange();
    f.componentInstance.start.set(new Date(2026, 3, 13));
    f.componentInstance.end.set(new Date(2026, 4, 20));
    f.detectChanges();
    const label = triggerLabel(f);
    expect(label).toContain('Apr');
    expect(label).toContain('13');
    expect(label).toContain('May');
    expect(label).toContain('20');
    expect(label).toContain('–');
  });

  it('formats as start – {openEndedLabel} when only start is set', () => {
    const f = setupRange({ openEnded: 'Open-ended' });
    f.componentInstance.start.set(new Date(2026, 4, 13));
    f.detectChanges();
    const label = triggerLabel(f);
    expect(label).toContain('May');
    expect(label).toContain('Open-ended');
  });

  it('formats as {openEndedLabel} – end when only end is set', () => {
    const f = setupRange();
    f.componentInstance.end.set(new Date(2026, 4, 20));
    f.detectChanges();
    const label = triggerLabel(f);
    expect(label).toContain('Open');
    expect(label).toContain('May');
  });

  it('updating start signal updates the label', () => {
    const f = setupRange();
    expect(triggerLabel(f)).toBe('Select date range');
    f.componentInstance.start.set(new Date(2026, 4, 13));
    f.detectChanges();
    expect(triggerLabel(f)).toContain('May');
  });
});
