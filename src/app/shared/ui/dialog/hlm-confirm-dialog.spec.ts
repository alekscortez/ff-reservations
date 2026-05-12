import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmConfirmDialog } from './hlm-confirm-dialog';

@Component({
  standalone: true,
  imports: [CommonModule, HlmConfirmDialog],
  template: `
    <hlm-confirm-dialog
      *ngIf="open"
      [title]="title"
      [message]="message"
      [confirmText]="confirmText"
      [cancelText]="cancelText"
      [loadingText]="loadingText"
      [destructive]="destructive"
      [loading]="loading"
      (confirm)="onConfirm()"
      (cancel)="onCancel()"
    />
  `,
})
class Host {
  open = true;
  title = 'Delete client?';
  message: string | null = 'This removes Maria López and their reservation history.';
  confirmText = 'Confirm';
  cancelText = 'Cancel';
  loadingText = 'Working…';
  destructive = false;
  loading = false;
  confirmCount = 0;
  cancelCount = 0;
  onConfirm() {
    this.confirmCount += 1;
  }
  onCancel() {
    this.cancelCount += 1;
  }
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function confirmButton(fixture: ReturnType<typeof createHost>): HTMLButtonElement {
  // confirm is the last button (cancel comes first in flex layout)
  const buttons = fixture.nativeElement.querySelectorAll('hlm-confirm-dialog button[hlmBtn]');
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

function cancelButton(fixture: ReturnType<typeof createHost>): HTMLButtonElement {
  // Cancel is the first button (renders before Confirm in flex layout).
  return fixture.nativeElement.querySelector(
    'hlm-confirm-dialog button[hlmBtn]',
  ) as HTMLButtonElement;
}

describe('HlmConfirmDialog', () => {
  it('renders title + message', () => {
    const f = createHost();
    const text = f.nativeElement.textContent ?? '';
    expect(text).toContain('Delete client?');
    expect(text).toContain('Maria López');
  });

  it('omits message paragraph when null', () => {
    const f = createHost({ message: null });
    expect(f.nativeElement.querySelector('hlm-confirm-dialog p')).toBeNull();
  });

  it('default variant: confirm button does NOT carry destructive classes', () => {
    const f = createHost();
    const btn = confirmButton(f);
    expect(btn.className).not.toContain('bg-destructive');
  });

  it('destructive=true: confirm button carries destructive classes', () => {
    const f = createHost({ destructive: true });
    const btn = confirmButton(f);
    expect(btn.className).toContain('bg-destructive');
  });

  it('shows loadingText + disables both buttons while loading', () => {
    const f = createHost({ loading: true, loadingText: 'Sending…' });
    const cancel = cancelButton(f);
    const confirm = confirmButton(f);
    expect(confirm.textContent?.trim()).toContain('Sending…');
    expect(cancel.disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
  });

  it('emits confirm when the confirm button is clicked', () => {
    const f = createHost();
    confirmButton(f).click();
    expect(f.componentInstance.confirmCount).toBe(1);
    expect(f.componentInstance.cancelCount).toBe(0);
  });

  it('emits cancel when the cancel button is clicked', () => {
    const f = createHost();
    cancelButton(f).click();
    expect(f.componentInstance.cancelCount).toBe(1);
    expect(f.componentInstance.confirmCount).toBe(0);
  });

  it('emits cancel when the underlying HlmDialog closes (Esc / backdrop)', () => {
    const f = createHost();
    // Backdrop is the inner div inside [role="dialog"]
    const backdrop = f.nativeElement.querySelector(
      'hlm-confirm-dialog [role="dialog"] > div',
    ) as HTMLElement;
    backdrop.click();
    expect(f.componentInstance.cancelCount).toBe(1);
  });

  it('uses custom confirmText + cancelText', () => {
    const f = createHost({ confirmText: 'Yes, delete', cancelText: 'Keep it' });
    expect(confirmButton(f).textContent?.trim()).toContain('Yes, delete');
    expect(cancelButton(f).textContent?.trim()).toContain('Keep it');
  });
});
