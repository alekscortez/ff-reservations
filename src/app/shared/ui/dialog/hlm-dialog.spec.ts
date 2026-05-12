import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmDialog } from './hlm-dialog';

@Component({
  standalone: true,
  imports: [CommonModule, HlmDialog],
  template: `
    <hlm-dialog
      *ngIf="open"
      [size]="size"
      [panelClass]="panelClass"
      (close)="onClose()"
    >
      <p>body</p>
    </hlm-dialog>
  `,
})
class Host {
  open = true;
  size: 'default' | 'full-on-mobile' | 'sheet' = 'default';
  panelClass = '';
  closeCount = 0;
  onClose() {
    this.closeCount += 1;
  }
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

// CDK's focus-trap adds `cdk-focus-trap-anchor` divs as siblings before/after
// the real dialog wrapper. Skip them by anchoring on `[role="dialog"]` which
// only the wrapper carries.
function wrapperDiv(fixture: ReturnType<typeof createHost>): HTMLElement {
  return fixture.nativeElement.querySelector('hlm-dialog [role="dialog"]');
}

function panelSection(fixture: ReturnType<typeof createHost>): HTMLElement {
  return fixture.nativeElement.querySelector('hlm-dialog section');
}

function backdropDiv(fixture: ReturnType<typeof createHost>): HTMLElement {
  return fixture.nativeElement.querySelector('hlm-dialog [role="dialog"] > div');
}

describe('HlmDialog', () => {
  it('default size: wrapper z-[200] + items-center, panel max-w-2xl rounded-2xl', () => {
    const f = createHost();
    const wrap = wrapperDiv(f).className;
    const panel = panelSection(f).className;
    expect(wrap).toContain('z-[200]');
    expect(wrap).toContain('items-center');
    expect(wrap).toContain('justify-center');
    expect(panel).toContain('max-w-2xl');
    expect(panel).toContain('rounded-2xl');
  });

  it('full-on-mobile size: panel goes full-screen on mobile, centered md+', () => {
    const f = createHost({ size: 'full-on-mobile' });
    const panel = panelSection(f).className;
    expect(panel).toContain('h-full');
    expect(panel).toContain('w-full');
    expect(panel).toContain('md:h-auto');
    expect(panel).toContain('md:max-w-2xl');
  });

  it('sheet size: wrapper z-[300] + items-end, panel rounded-t-2xl → sm:rounded-2xl', () => {
    const f = createHost({ size: 'sheet' });
    const wrap = wrapperDiv(f).className;
    const panel = panelSection(f).className;
    expect(wrap).toContain('z-[300]');
    expect(wrap).toContain('items-end');
    expect(panel).toContain('rounded-t-2xl');
    expect(panel).toContain('sm:w-[360px]');
  });

  it('panelClass merges with size defaults (consumer wins for conflicts)', () => {
    const f = createHost({ panelClass: 'max-w-md pb-28' });
    const panel = panelSection(f).className;
    // Consumer max-w-md overrides default max-w-2xl
    expect(panel).toContain('max-w-md');
    expect(panel).not.toContain('max-w-2xl');
    // Consumer additive pb-28 preserved
    expect(panel).toContain('pb-28');
  });

  it('emits close when backdrop is clicked', () => {
    const f = createHost();
    const host = f.componentInstance;
    backdropDiv(f).click();
    expect(host.closeCount).toBe(1);
  });

  it('renders projected content', () => {
    const f = createHost();
    expect(panelSection(f).textContent).toContain('body');
  });

  it('locks body overflow while mounted + restores on destroy', () => {
    const beforeMount = document.body.style.overflow;
    const f = createHost();
    expect(document.body.style.overflow).toBe('hidden');
    f.destroy();
    // restored to whatever it was before (typically '')
    expect(document.body.style.overflow).toBe(beforeMount);
  });
});
