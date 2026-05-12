import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmBadge } from './hlm-badge';

@Component({
  standalone: true,
  imports: [HlmBadge],
  template: `<span hlmBadge [variant]="variant" [size]="size" [class]="extra">x</span>`,
})
class Host {
  variant:
    | 'default'
    | 'secondary'
    | 'outline'
    | 'destructive'
    | 'success'
    | 'warning'
    | 'danger' = 'secondary';
  size: 'default' | 'sm' | 'xs' = 'default';
  extra = '';
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function badgeClass(fixture: ReturnType<typeof createHost>): string {
  return fixture.nativeElement.querySelector('span').className;
}

describe('HlmBadge', () => {
  it('default variant is secondary (bg-secondary)', () => {
    const cls = badgeClass(createHost());
    expect(cls).toContain('bg-secondary');
    expect(cls).toContain('text-secondary-foreground');
  });

  it('success variant uses success palette', () => {
    const cls = badgeClass(createHost({ variant: 'success' }));
    expect(cls).toContain('bg-success-100');
    expect(cls).toContain('text-success-800');
    expect(cls).toContain('border-success-200');
  });

  it('warning variant uses warning palette', () => {
    const cls = badgeClass(createHost({ variant: 'warning' }));
    expect(cls).toContain('bg-warning-100');
    expect(cls).toContain('text-warning-800');
  });

  it('danger variant uses danger palette', () => {
    const cls = badgeClass(createHost({ variant: 'danger' }));
    expect(cls).toContain('bg-danger-100');
    expect(cls).toContain('text-danger-800');
  });

  it('outline variant uses border-current + transparent bg', () => {
    const cls = badgeClass(createHost({ variant: 'outline' }));
    expect(cls).toContain('border-current');
    expect(cls).toContain('bg-transparent');
  });

  it('sm size applies h-6 + smaller padding', () => {
    const cls = badgeClass(createHost({ size: 'sm' }));
    expect(cls).toContain('h-6');
    expect(cls).toContain('px-2');
  });

  it('consumer class merges (preserved)', () => {
    const cls = badgeClass(createHost({ extra: 'shrink-0' }));
    expect(cls).toContain('shrink-0');
    expect(cls).toContain('bg-secondary');
  });
});
