import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { HlmCheckbox } from './hlm-checkbox';

@Component({
  standalone: true,
  imports: [HlmCheckbox],
  template: `<hlm-checkbox [(checked)]="picked" [size]="size" label="Agree" [class]="extra" />`,
})
class TwoWayHost {
  picked = signal<boolean>(false);
  size: 'default' | 'sm' = 'default';
  extra = '';
}

@Component({
  standalone: true,
  imports: [HlmCheckbox, ReactiveFormsModule],
  template: `<hlm-checkbox [formControl]="ctrl" label="SMS" />`,
})
class FormControlHost {
  ctrl = new FormControl<boolean>(true, { nonNullable: true });
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
  return fixture.nativeElement.querySelector('input[type="checkbox"]');
}

function boxEl(fixture: any): HTMLElement {
  return fixture.nativeElement.querySelector('label > span:first-child');
}

describe('HlmCheckbox', () => {
  it('renders a hidden native checkbox + visible styled box', () => {
    const f = setupTwoWay();
    expect(inputEl(f)).toBeTruthy();
    expect(inputEl(f).className).toContain('sr-only');
    expect(boxEl(f).className).toContain('h-4');
    expect(boxEl(f).className).toContain('w-4');
  });

  it('renders projected label text', () => {
    const f = setupTwoWay();
    expect(f.nativeElement.textContent).toContain('Agree');
  });

  it('default unchecked state has no checkmark icon', () => {
    const f = setupTwoWay();
    expect(f.nativeElement.querySelector('ng-icon[name="lucideCheck"]')).toBeFalsy();
  });

  it('checked state shows the checkmark icon', () => {
    const f = setupTwoWay();
    f.componentInstance.picked.set(true);
    f.detectChanges();
    expect(f.nativeElement.querySelector('ng-icon[name="lucideCheck"]')).toBeTruthy();
    expect(boxEl(f).className).toContain('bg-primary');
  });

  it('clicking the input toggles the [(checked)] signal', () => {
    const f = setupTwoWay();
    const input = inputEl(f);
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(f.componentInstance.picked()).toBe(true);
  });

  it('formControl two-way binding round-trips', () => {
    const f = setupForm();
    expect(inputEl(f).checked).toBe(true);

    const input = inputEl(f);
    input.checked = false;
    input.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(f.componentInstance.ctrl.value).toBe(false);

    f.componentInstance.ctrl.setValue(true);
    f.detectChanges();
    expect(inputEl(f).checked).toBe(true);
  });

  it('formControl disable propagates to the input', () => {
    const f = setupForm();
    f.componentInstance.ctrl.disable();
    f.detectChanges();
    expect(inputEl(f).disabled).toBe(true);
  });

  it('(change) output emits ONLY on user changes, not on writeValue', () => {
    const f = setupForm();
    const emissions: boolean[] = [];
    const hlmEl = f.debugElement.children[0].componentInstance;
    hlmEl.change.subscribe((v: boolean) => emissions.push(v));

    f.componentInstance.ctrl.setValue(false);
    f.detectChanges();
    expect(emissions).toEqual([]);

    const input = inputEl(f);
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(emissions).toEqual([true]);
  });

  it('sm size applies h-3.5 w-3.5', () => {
    const f = setupTwoWay({ size: 'sm' });
    expect(boxEl(f).className).toContain('h-3.5');
    expect(boxEl(f).className).toContain('w-3.5');
  });

  it('consumer class merges via tailwind-merge', () => {
    const f = setupTwoWay({ extra: 'h-6 w-6 rounded-md' });
    expect(boxEl(f).className).toContain('h-6');
    expect(boxEl(f).className).not.toContain('h-4');
    expect(boxEl(f).className).toContain('rounded-md');
    expect(boxEl(f).className).not.toContain('rounded ');
  });
});
