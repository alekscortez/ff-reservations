import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { HlmTimePicker } from './hlm-time-picker';

@Component({
  standalone: true,
  imports: [HlmTimePicker],
  template: `
    <hlm-time-picker
      [(value)]="picked"
      [size]="size"
      [min]="min"
      [max]="max"
      [class]="extra"
      aria-label="When"
    />
  `,
})
class TwoWayHost {
  picked = signal<string>('');
  size: 'default' | 'sm' = 'default';
  min = '';
  max = '';
  extra = '';
}

@Component({
  standalone: true,
  imports: [HlmTimePicker, ReactiveFormsModule],
  template: `<hlm-time-picker [formControl]="ctrl" />`,
})
class FormControlHost {
  ctrl = new FormControl<string>('09:00', { nonNullable: true });
}

function setupTwoWay(initial?: Partial<TwoWayHost>) {
  TestBed.configureTestingModule({ imports: [TwoWayHost] });
  const fixture = TestBed.createComponent(TwoWayHost);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function setupForm() {
  TestBed.configureTestingModule({ imports: [FormControlHost] });
  const fixture = TestBed.createComponent(FormControlHost);
  fixture.detectChanges();
  return fixture;
}

function inputEl(fixture: any): HTMLInputElement {
  return fixture.nativeElement.querySelector('input[type="time"]');
}

describe('HlmTimePicker', () => {
  it('renders a native <input type="time">', () => {
    expect(inputEl(setupTwoWay())).toBeTruthy();
  });

  it('default size applies h-9 padding', () => {
    const cls = inputEl(setupTwoWay()).className;
    expect(cls).toContain('h-9');
    expect(cls).toContain('px-3');
  });

  it('sm size applies h-8 + tighter padding', () => {
    const cls = inputEl(setupTwoWay({ size: 'sm' })).className;
    expect(cls).toContain('h-8');
    expect(cls).toContain('px-2');
  });

  it('forwards aria-label to the input', () => {
    expect(inputEl(setupTwoWay()).getAttribute('aria-label')).toBe('When');
  });

  it('passes min/max through to the native input', () => {
    const f = setupTwoWay({ min: '06:00', max: '23:00' });
    expect(inputEl(f).getAttribute('min')).toBe('06:00');
    expect(inputEl(f).getAttribute('max')).toBe('23:00');
  });

  it('omits min/max attrs when not provided', () => {
    const input = inputEl(setupTwoWay());
    expect(input.hasAttribute('min')).toBe(false);
    expect(input.hasAttribute('max')).toBe(false);
  });

  it('typing into the input updates the [(value)] signal', () => {
    const f = setupTwoWay();
    const input = inputEl(f);
    input.value = '14:30';
    input.dispatchEvent(new Event('input'));
    f.detectChanges();
    expect(f.componentInstance.picked()).toBe('14:30');
  });

  it('updating the [(value)] signal updates the input', () => {
    const f = setupTwoWay();
    f.componentInstance.picked.set('07:45');
    f.detectChanges();
    expect(inputEl(f).value).toBe('07:45');
  });

  it('formControl two-way binding round-trips', () => {
    const f = setupForm();
    expect(inputEl(f).value).toBe('09:00');

    const input = inputEl(f);
    input.value = '22:15';
    input.dispatchEvent(new Event('input'));
    f.detectChanges();
    expect(f.componentInstance.ctrl.value).toBe('22:15');

    f.componentInstance.ctrl.setValue('00:00');
    f.detectChanges();
    expect(inputEl(f).value).toBe('00:00');
  });

  it('formControl disable propagates to the input', () => {
    const f = setupForm();
    f.componentInstance.ctrl.disable();
    f.detectChanges();
    expect(inputEl(f).disabled).toBe(true);
  });

  it('(change) output emits ONLY on user input, not on writeValue', () => {
    const f = setupForm();
    const emissions: string[] = [];
    const hlmEl = f.debugElement.children[0].componentInstance;
    hlmEl.change.subscribe((v: string) => emissions.push(v));

    f.componentInstance.ctrl.setValue('11:00');
    f.detectChanges();
    expect(emissions).toEqual([]);

    const input = inputEl(f);
    input.value = '12:00';
    input.dispatchEvent(new Event('input'));
    f.detectChanges();
    expect(emissions).toEqual(['12:00']);
  });

  it('writeValue("") clears to empty string', () => {
    const f = setupForm();
    f.componentInstance.ctrl.setValue('');
    f.detectChanges();
    expect(inputEl(f).value).toBe('');
  });

  it('consumer class merges via tailwind-merge', () => {
    const cls = inputEl(setupTwoWay({ extra: 'h-12 rounded-xl' })).className;
    expect(cls).toContain('h-12');
    expect(cls).not.toContain('h-9');
    expect(cls).toContain('rounded-xl');
    expect(cls).not.toContain('rounded-md');
  });
});
