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
      [ariaLabel]="ariaLabel"
      [ariaLabelledBy]="ariaLabelledBy"
      (close)="onClose()"
    >
      <p>body</p>
    </hlm-dialog>
  `,
})
class Host {
  open = true;
  size: 'default' | 'full-on-mobile' | 'sheet' | 'fullscreen' = 'default';
  panelClass = '';
  ariaLabel = '';
  ariaLabelledBy = '';
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

  it('sheet size: panel max-h gates overflow + iOS safe-area insets honored', () => {
    // Without max-h the panel grows past the viewport; combined with
    // items-end this pushes the top (and the close button consumers
    // sticky there) off-screen. dvh keeps the viewport gate honest as
    // mobile chrome shows/hides.
    const f = createHost({ size: 'sheet' });
    const panel = panelSection(f).className;
    expect(panel).toContain('max-h-[100dvh]');
    expect(panel).toContain('pt-[env(safe-area-inset-top)]');
    expect(panel).toContain('pb-[env(safe-area-inset-bottom)]');
    // Desktop sheet starts ~68px from top (sm:pt-[68px] on the wrapper);
    // shave a bit more so the bottom shadow doesn't clip on short screens.
    expect(panel).toContain('sm:max-h-[calc(100dvh-84px)]');
    expect(panel).toContain('sm:pt-0');
  });

  it('fullscreen size: panel fills viewport edge-to-edge, no rounding, no width cap', () => {
    const f = createHost({ size: 'fullscreen' });
    const wrap = wrapperDiv(f).className;
    const panel = panelSection(f).className;
    expect(wrap).toContain('z-[200]');
    expect(wrap).toContain('flex');
    // No items-center / justify-center on fullscreen — the panel fills
    // the wrapper directly via h/w 100%
    expect(wrap).not.toContain('items-center');
    expect(panel).toContain('h-[100dvh]');
    expect(panel).toContain('w-screen');
    expect(panel).toContain('max-w-none');
    expect(panel).toContain('rounded-none');
    // Safe-area insets so the iOS status bar / home indicator do not
    // overlap controls inside the panel
    expect(panel).toContain('pt-[env(safe-area-inset-top)]');
    expect(panel).toContain('pb-[env(safe-area-inset-bottom)]');
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

  it('omits aria-labelledby + aria-label when neither input is set', () => {
    const f = createHost();
    const wrap = wrapperDiv(f);
    expect(wrap.hasAttribute('aria-labelledby')).toBe(false);
    expect(wrap.hasAttribute('aria-label')).toBe(false);
    expect(wrap.getAttribute('role')).toBe('dialog');
    expect(wrap.getAttribute('aria-modal')).toBe('true');
  });

  it('applies aria-labelledby when input is set', () => {
    const f = createHost({ ariaLabelledBy: 'modal-title' });
    expect(wrapperDiv(f).getAttribute('aria-labelledby')).toBe('modal-title');
  });

  it('applies aria-label when input is set', () => {
    const f = createHost({ ariaLabel: 'Take Payment' });
    expect(wrapperDiv(f).getAttribute('aria-label')).toBe('Take Payment');
  });

  it('locks html + body overflow while mounted + restores on destroy', () => {
    const beforeHtml = document.documentElement.style.overflow;
    const beforeBody = document.body.style.overflow;
    const f = createHost();
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');
    f.destroy();
    // restored to whatever each was before (typically '')
    expect(document.documentElement.style.overflow).toBe(beforeHtml);
    expect(document.body.style.overflow).toBe(beforeBody);
  });
});
