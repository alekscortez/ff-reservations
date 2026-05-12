import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmButton } from './hlm-button';

@Component({
  standalone: true,
  imports: [HlmButton],
  template: `
    <button hlmBtn [variant]="variant" [size]="size" [class]="extra">go</button>
  `,
})
class Host {
  variant: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link' = 'default';
  size:
    | 'default'
    | 'xs'
    | 'sm'
    | 'lg'
    | 'icon'
    | 'icon-xs'
    | 'icon-sm'
    | 'icon-lg' = 'default';
  extra = '';
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function btnClass(fixture: ReturnType<typeof createHost>): string {
  return fixture.nativeElement.querySelector('button').className;
}

describe('HlmButton', () => {
  it('applies default variant + default size classes', () => {
    const f = createHost();
    const cls = btnClass(f);
    expect(cls).toContain('bg-primary');
    expect(cls).toContain('text-primary-foreground');
    expect(cls).toContain('h-10');
    expect(cls).toContain('px-4');
  });

  it('outline variant uses border-input + bg-background', () => {
    const f = createHost({ variant: 'outline' });
    const cls = btnClass(f);
    expect(cls).toContain('border-input');
    expect(cls).toContain('bg-background');
    expect(cls).toContain('text-foreground');
  });

  it('destructive variant uses bg-destructive', () => {
    const f = createHost({ variant: 'destructive' });
    expect(btnClass(f)).toContain('bg-destructive');
  });

  it('sm size applies h-9 + text-xs', () => {
    const f = createHost({ size: 'sm' });
    const cls = btnClass(f);
    expect(cls).toContain('h-9');
    expect(cls).toContain('text-xs');
  });

  it('icon size applies h-10 w-10', () => {
    const f = createHost({ size: 'icon' });
    const cls = btnClass(f);
    expect(cls).toContain('h-10');
    expect(cls).toContain('w-10');
  });

  it('preserves consumer classes via tailwind-merge', () => {
    const f = createHost({ extra: 'w-full mt-2' });
    const cls = btnClass(f);
    expect(cls).toContain('w-full');
    expect(cls).toContain('mt-2');
    // base variant classes still present
    expect(cls).toContain('bg-primary');
  });

  it('consumer class overrides variant where they conflict (tailwind-merge)', () => {
    // Consumer passes rounded-full; base has rounded-lg. Merge should keep
    // rounded-full (consumer wins) and drop rounded-lg.
    const f = createHost({ extra: 'rounded-full' });
    const cls = btnClass(f);
    expect(cls).toContain('rounded-full');
    expect(cls).not.toContain('rounded-lg');
  });
});
