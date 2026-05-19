import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HlmNumpad, type HlmNumpadMode } from './hlm-numpad';

@Component({
  standalone: true,
  imports: [HlmNumpad],
  template: `
    <hlm-numpad
      [value]="value"
      [mode]="mode"
      [caption]="caption"
      [disabled]="disabled"
      (valueChange)="onChange($event)"
      (done)="onDone()"
    />
  `,
})
class Host {
  value = '';
  mode: HlmNumpadMode = 'integer';
  caption = '';
  disabled = false;
  emitted: string[] = [];
  doneCount = 0;
  onChange(next: string) {
    this.emitted.push(next);
    this.value = next;
  }
  onDone() {
    this.doneCount += 1;
  }
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  if (initial) Object.assign(fixture.componentInstance, initial);
  fixture.detectChanges();
  return fixture;
}

function buttonByLabel(
  fixture: ReturnType<typeof createHost>,
  label: string
): HTMLButtonElement {
  const btn = fixture.nativeElement.querySelector(
    `button[aria-label="${label}"]`
  ) as HTMLButtonElement | null;
  if (!btn) throw new Error(`button with aria-label="${label}" not found`);
  return btn;
}

describe('HlmNumpad', () => {
  it('renders 10 digit buttons + Backspace + Done', () => {
    const f = createHost();
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(buttonByLabel(f, `Number ${d}`)).toBeTruthy();
    }
    expect(buttonByLabel(f, 'Backspace')).toBeTruthy();
    expect(buttonByLabel(f, 'Done')).toBeTruthy();
  });

  it('digit tap emits valueChange with appended digit', () => {
    const f = createHost({ value: '95' });
    buttonByLabel(f, 'Number 6').click();
    expect(f.componentInstance.emitted).toEqual(['956']);
  });

  it('backspace emits valueChange with last char removed', () => {
    const f = createHost({ value: '9561' });
    buttonByLabel(f, 'Backspace').click();
    expect(f.componentInstance.emitted).toEqual(['956']);
  });

  it('done button emits done event', () => {
    const f = createHost();
    buttonByLabel(f, 'Done').click();
    expect(f.componentInstance.doneCount).toBe(1);
  });

  it('backspace is disabled at empty value', () => {
    const f = createHost({ value: '' });
    expect(buttonByLabel(f, 'Backspace').disabled).toBe(true);
  });

  it('phone mode: digit keys are disabled once 10 digits are entered', () => {
    const f = createHost({ value: '9561234567', mode: 'phone' });
    expect(buttonByLabel(f, 'Number 5').disabled).toBe(true);
    expect(buttonByLabel(f, 'Number 0').disabled).toBe(true);
    expect(buttonByLabel(f, 'Backspace').disabled).toBe(false);
    expect(buttonByLabel(f, 'Done').disabled).toBe(false);
  });

  it('phone mode: digit tap is silently dropped when value is already 10 digits', () => {
    const f = createHost({ value: '9561234567', mode: 'phone' });
    buttonByLabel(f, 'Number 8').click();
    expect(f.componentInstance.emitted).toEqual([]);
  });

  it('phone mode: counts only digits (ignores any non-digit characters in value)', () => {
    // Caller may pass a formatted "(956) 123-4567" — keypad reads 10 digits
    const f = createHost({ value: '(956) 123-4567', mode: 'phone' });
    expect(buttonByLabel(f, 'Number 1').disabled).toBe(true);
  });

  it('integer mode: digit keys stay enabled past 10 digits', () => {
    const f = createHost({ value: '1234567890123', mode: 'integer' });
    expect(buttonByLabel(f, 'Number 1').disabled).toBe(false);
  });

  it('disabled input: all keys are disabled including Done', () => {
    const f = createHost({ value: '95', disabled: true });
    expect(buttonByLabel(f, 'Number 1').disabled).toBe(true);
    expect(buttonByLabel(f, 'Backspace').disabled).toBe(true);
    expect(buttonByLabel(f, 'Done').disabled).toBe(true);
  });

  it('caption renders when set', () => {
    const f = createHost({ caption: '→ Phone' });
    expect(f.nativeElement.textContent).toContain('→ Phone');
  });

  it('caption is omitted when empty (no aria-live region rendered)', () => {
    const f = createHost();
    expect(f.nativeElement.querySelector('p[aria-live]')).toBeNull();
  });

  it('numeric keypad group has accessible role + label', () => {
    const f = createHost();
    const group = f.nativeElement.querySelector('[role="group"]');
    expect(group).toBeTruthy();
    expect(group.getAttribute('aria-label')).toBe('Numeric keypad');
  });

  it('null/undefined value is treated as empty string', () => {
    const f = createHost({ value: undefined as unknown as string });
    expect(buttonByLabel(f, 'Backspace').disabled).toBe(true);
    buttonByLabel(f, 'Number 9').click();
    expect(f.componentInstance.emitted).toEqual(['9']);
  });
});
