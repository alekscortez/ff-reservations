import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style wrapper around the native `<input type="time">`. Uses the
 * platform time picker UI (free a11y, native wheel on iOS/Android, keyboard
 * spinner on desktop) but normalizes the visual chrome — Spartan border,
 * focus ring, padding.
 *
 * Value is always a 24-hour `HH:MM` string. Empty string when cleared.
 *
 * @example
 *   <hlm-time-picker [(value)]="checkInAt" />
 *
 *   <hlm-time-picker [formControl]="form.controls.openAt" min="06:00" max="23:00" />
 *
 * Sizes: `default` (h-9) | `sm` (h-8). Override per-instance with
 * `class="..."` (tailwind-merge: consumer wins on conflict).
 */
export const timePickerVariants = cva(
  'w-full rounded-md border border-brand-200 bg-white text-sm text-brand-900 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-300 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-9 px-3',
        sm: 'h-8 px-2 text-sm',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

export type TimePickerVariants = VariantProps<typeof timePickerVariants>;

@Component({
  selector: 'hlm-time-picker',
  standalone: true,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => HlmTimePicker),
      multi: true,
    },
  ],
  template: `
    <input
      type="time"
      [class]="classes()"
      [value]="value()"
      [disabled]="disabled()"
      [attr.min]="min() || null"
      [attr.max]="max() || null"
      [attr.step]="step() || null"
      [attr.aria-label]="ariaLabel() || null"
      (input)="onInputChange($event)"
      (blur)="onBlur()"
    />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HlmTimePicker implements ControlValueAccessor {
  public readonly size = input<TimePickerVariants['size']>('default');
  public readonly value = model<string>('');
  public readonly min = input<string>('');
  public readonly max = input<string>('');
  /** Step in seconds. Default 60 (1 min). Use 1 to allow seconds entry. */
  public readonly step = input<number | null>(null);
  public readonly ariaLabel = input<string>('', { alias: 'aria-label' });
  public readonly extraClass = input<string>('', { alias: 'class' });

  /**
   * Emits on USER-initiated changes only — not on programmatic
   * `writeValue` from the FormControl.
   */
  public readonly change = output<string>();

  protected readonly disabled = signal<boolean>(false);

  protected readonly classes = computed(() =>
    twMerge(timePickerVariants({ size: this.size() }), this.extraClass()),
  );

  private _onChange: (value: string) => void = () => {};
  private _onTouched: () => void = () => {};

  writeValue(value: string | null | undefined): void {
    this.value.set(value ?? '');
  }

  registerOnChange(fn: (value: string) => void): void {
    this._onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this._onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected onInputChange(event: Event): void {
    const next = (event.target as HTMLInputElement).value;
    this.value.set(next);
    this._onChange(next);
    this.change.emit(next);
  }

  protected onBlur(): void {
    this._onTouched();
  }
}
