import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmPopoverContent } from './hlm-popover-content';

@Component({
  standalone: true,
  imports: [HlmPopoverContent],
  template: `<div hlmPopoverContent [class]="extra">body</div>`,
})
class Host {
  extra = '';
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function panel(fixture: ReturnType<typeof createHost>): HTMLElement {
  return fixture.nativeElement.querySelector('[hlmPopoverContent]');
}

describe('HlmPopoverContent', () => {
  it('sets role="dialog" on the host element', () => {
    const el = panel(createHost());
    expect(el.getAttribute('role')).toBe('dialog');
  });

  it('applies default panel chrome (border, bg, shadow, rounded, padding)', () => {
    const cls = panel(createHost()).className;
    expect(cls).toContain('bg-white');
    expect(cls).toContain('rounded-md');
    expect(cls).toContain('shadow-lg');
    expect(cls).toContain('border-brand-200');
    expect(cls).toContain('p-4');
  });

  it('defaults z-index to z-[210] so popovers float above HlmDialog z-[200]', () => {
    expect(panel(createHost()).className).toContain('z-[210]');
  });

  it('consumer class merges with defaults via tailwind-merge (conflicts win)', () => {
    const cls = panel(createHost({ extra: 'w-96 rounded-lg p-2' })).className;
    expect(cls).toContain('w-96');
    expect(cls).not.toContain('w-72');
    expect(cls).toContain('rounded-lg');
    expect(cls).not.toContain('rounded-md');
    expect(cls).toContain('p-2');
    expect(cls).not.toContain('p-4');
  });

  it('non-conflicting consumer classes are additive', () => {
    const cls = panel(createHost({ extra: 'space-y-2' })).className;
    expect(cls).toContain('space-y-2');
    expect(cls).toContain('bg-white');
  });
});
