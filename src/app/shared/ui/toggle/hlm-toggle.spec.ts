import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmToggle } from './hlm-toggle';

@Component({
  standalone: true,
  imports: [HlmToggle],
  template: `<button hlmToggle [variant]="variant" [active]="active">go</button>`,
})
class Host {
  variant: 'default' | 'outline' | 'warning' = 'default';
  active = false;
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

describe('HlmToggle', () => {
  it('default + inactive: transparent bg, text-foreground', () => {
    const cls = btnClass(createHost());
    expect(cls).toContain('text-foreground');
    expect(cls).toContain('hover:bg-muted');
    expect(cls).not.toContain('bg-primary');
  });

  it('default + active: bg-primary + primary-foreground text', () => {
    const cls = btnClass(createHost({ active: true }));
    expect(cls).toContain('bg-primary');
    expect(cls).toContain('text-primary-foreground');
  });

  it('outline + inactive: border-input + bg-background', () => {
    const cls = btnClass(createHost({ variant: 'outline' }));
    expect(cls).toContain('border-input');
    expect(cls).toContain('bg-background');
    expect(cls).toContain('text-foreground');
  });

  it('outline + active: border-primary + bg-primary', () => {
    const cls = btnClass(createHost({ variant: 'outline', active: true }));
    expect(cls).toContain('border-primary');
    expect(cls).toContain('bg-primary');
  });

  it('warning + inactive: amber 100 bg', () => {
    const cls = btnClass(createHost({ variant: 'warning' }));
    expect(cls).toContain('bg-warning-100');
    expect(cls).toContain('text-warning-800');
  });

  it('warning + active: amber 800 bg', () => {
    const cls = btnClass(createHost({ variant: 'warning', active: true }));
    expect(cls).toContain('bg-warning-800');
    expect(cls).toContain('text-warning-50');
  });
});
