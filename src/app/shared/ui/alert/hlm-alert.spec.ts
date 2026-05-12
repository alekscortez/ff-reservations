import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmAlert } from './hlm-alert';

@Component({
  standalone: true,
  imports: [HlmAlert],
  template: `<hlm-alert [variant]="variant" [class]="extra">message</hlm-alert>`,
})
class Host {
  variant: 'info' | 'success' | 'warning' | 'destructive' = 'info';
  extra = '';
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function alertDiv(fixture: ReturnType<typeof createHost>): HTMLElement {
  return fixture.nativeElement.querySelector('hlm-alert div');
}

describe('HlmAlert', () => {
  it('renders a div with role="alert" and projected content', () => {
    const f = createHost();
    const div = alertDiv(f);
    expect(div.getAttribute('role')).toBe('alert');
    expect(div.textContent?.trim()).toBe('message');
  });

  it('info variant uses brand neutral palette', () => {
    const cls = alertDiv(createHost()).className;
    expect(cls).toContain('bg-brand-50');
    expect(cls).toContain('text-brand-700');
  });

  it('success variant uses success palette', () => {
    const cls = alertDiv(createHost({ variant: 'success' })).className;
    expect(cls).toContain('bg-success-50');
    expect(cls).toContain('text-success-700');
  });

  it('destructive variant uses danger palette', () => {
    const cls = alertDiv(createHost({ variant: 'destructive' })).className;
    expect(cls).toContain('bg-danger-50');
    expect(cls).toContain('text-danger-700');
  });

  it('warning variant uses warning palette', () => {
    const cls = alertDiv(createHost({ variant: 'warning' })).className;
    expect(cls).toContain('bg-warning-50');
    expect(cls).toContain('text-warning-800');
  });

  it('preserves consumer class via tailwind-merge', () => {
    const cls = alertDiv(createHost({ extra: 'mt-4 rounded-xl p-3' })).className;
    expect(cls).toContain('mt-4');
    // Consumer rounded-xl + p-3 should override base rounded-lg + px-3/py-2
    expect(cls).toContain('rounded-xl');
    expect(cls).not.toContain('rounded-lg');
    expect(cls).toContain('p-3');
  });
});
