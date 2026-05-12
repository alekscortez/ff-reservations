import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmInput } from './hlm-input';

@Component({
  standalone: true,
  imports: [HlmInput],
  template: `<input hlmInput [size]="size" [class]="extra" />`,
})
class Host {
  size: 'default' | 'sm' | 'lg' = 'default';
  extra = '';
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function inputClass(fixture: ReturnType<typeof createHost>): string {
  return fixture.nativeElement.querySelector('input').className;
}

describe('HlmInput', () => {
  it('default size applies h-10 + text-sm', () => {
    const cls = inputClass(createHost());
    expect(cls).toContain('h-10');
    expect(cls).toContain('text-sm');
  });

  it('sm size applies h-9 + text-xs', () => {
    const cls = inputClass(createHost({ size: 'sm' }));
    expect(cls).toContain('h-9');
    expect(cls).toContain('text-xs');
  });

  it('lg size applies h-11', () => {
    const cls = inputClass(createHost({ size: 'lg' }));
    expect(cls).toContain('h-11');
  });

  it('base classes include border-input + bg-background + focus:border-ring', () => {
    const cls = inputClass(createHost());
    expect(cls).toContain('border-input');
    expect(cls).toContain('bg-background');
    expect(cls).toContain('focus:border-ring');
  });

  it('preserves consumer min-w-0 / flex-1 / text-xs overrides via tailwind-merge', () => {
    const cls = inputClass(createHost({ extra: 'min-w-0 flex-1' }));
    expect(cls).toContain('min-w-0');
    expect(cls).toContain('flex-1');
    // base still present
    expect(cls).toContain('border-input');
  });
});
