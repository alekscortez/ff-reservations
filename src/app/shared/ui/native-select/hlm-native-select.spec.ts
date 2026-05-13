import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { HlmNativeSelect } from './hlm-native-select';

@Component({
  standalone: true,
  imports: [HlmNativeSelect],
  template: `
    <hlm-native-select [(value)]="picked" [size]="size" [class]="extra">
      <option value="">— pick —</option>
      <option value="apple">Apple</option>
      <option value="banana">Banana</option>
    </hlm-native-select>
  `,
})
class TwoWayHost {
  picked = signal<string>('');
  size: 'default' | 'sm' = 'default';
  extra = '';
}

@Component({
  standalone: true,
  imports: [HlmNativeSelect, ReactiveFormsModule],
  template: `
    <hlm-native-select [formControl]="ctrl">
      <option value="A">A</option>
      <option value="B">B</option>
    </hlm-native-select>
  `,
})
class FormControlHost {
  ctrl = new FormControl<string>('A', { nonNullable: true });
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

function selectEl(fixture: any): HTMLSelectElement {
  return fixture.nativeElement.querySelector('select');
}

describe('HlmNativeSelect', () => {
  it('renders a native <select> with projected <option> children', () => {
    const f = setupTwoWay();
    const opts = selectEl(f).options;
    expect(opts.length).toBe(3);
    expect(opts[1].value).toBe('apple');
  });

  it('renders the chevron-down icon as a visual overlay', () => {
    const f = setupTwoWay();
    const icon = f.nativeElement.querySelector('ng-icon[name="lucideChevronDown"]');
    expect(icon).toBeTruthy();
    expect(icon.className).toContain('pointer-events-none');
    expect(icon.className).toContain('absolute');
  });

  it('default size applies h-9 padding-right reservation', () => {
    const cls = selectEl(setupTwoWay()).className;
    expect(cls).toContain('h-9');
    expect(cls).toContain('pr-8');
  });

  it('sm size applies h-8 + tighter padding', () => {
    const cls = selectEl(setupTwoWay({ size: 'sm' })).className;
    expect(cls).toContain('h-8');
    expect(cls).toContain('pr-7');
  });

  it('appearance-none kills the OS default chevron', () => {
    expect(selectEl(setupTwoWay()).className).toContain('appearance-none');
  });

  it('changing the select updates the [(value)] signal', () => {
    const f = setupTwoWay();
    const sel = selectEl(f);
    sel.value = 'banana';
    sel.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(f.componentInstance.picked()).toBe('banana');
  });

  it('updating the [(value)] signal updates the select', () => {
    const f = setupTwoWay();
    f.componentInstance.picked.set('apple');
    f.detectChanges();
    expect(selectEl(f).value).toBe('apple');
  });

  it('formControl two-way binding round-trips', () => {
    const f = setupForm();
    expect(selectEl(f).value).toBe('A');

    const sel = selectEl(f);
    sel.value = 'B';
    sel.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(f.componentInstance.ctrl.value).toBe('B');

    f.componentInstance.ctrl.setValue('A');
    f.detectChanges();
    expect(selectEl(f).value).toBe('A');
  });

  it('formControl disable propagates to the select', () => {
    const f = setupForm();
    f.componentInstance.ctrl.disable();
    f.detectChanges();
    expect(selectEl(f).disabled).toBe(true);
  });

  it('(change) output emits ONLY on user changes, not on FormControl writeValue', () => {
    const f = setupForm();
    const emissions: string[] = [];
    // Patch a (change) listener onto the component instance after the fact
    const hlmEl = f.debugElement.children[0].componentInstance;
    hlmEl.change.subscribe((v: string) => emissions.push(v));

    // Programmatic setValue should NOT fire (change)
    f.componentInstance.ctrl.setValue('B');
    f.detectChanges();
    expect(emissions).toEqual([]);

    // User select change DOES fire (change)
    const sel = selectEl(f);
    sel.value = 'A';
    sel.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(emissions).toEqual(['A']);
  });

  it('consumer class merges via tailwind-merge', () => {
    const cls = selectEl(setupTwoWay({ extra: 'h-12 rounded-xl' })).className;
    expect(cls).toContain('h-12');
    expect(cls).not.toContain('h-9');
    expect(cls).toContain('rounded-xl');
    expect(cls).not.toContain('rounded-md');
  });
});
