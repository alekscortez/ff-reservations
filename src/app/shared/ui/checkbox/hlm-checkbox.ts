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
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style checkbox. Renders a styled box (NOT the native browser
 * checkbox) with a lucideCheck overlay when checked. Wraps a hidden
 * native input for keyboard + screen-reader semantics.
 *
 * @example
 *   <hlm-checkbox [(checked)]="agreed" label="I agree" />
 *
 *   <hlm-checkbox [formControl]="form.controls.smsEnabled" label="SMS sending enabled" />
 *
 * Sizes: `default` (h-4 w-4) | `sm` (h-3.5 w-3.5).
 *
 * Use HlmToggle for inline pill chips. Use HlmCheckbox for "feature on/off"
 * or "I agree" booleans where the user expects a checkbox shape.
 */
export const checkboxVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded border border-brand-300 bg-white text-white transition-colors focus-within:ring-2 focus-within:ring-brand-300 focus-within:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-4 w-4',
        sm: 'h-3.5 w-3.5',
      },
      checked: {
        true: 'border-primary bg-primary',
        false: 'hover:border-brand-400',
      },
    },
    defaultVariants: { size: 'default', checked: false },
  },
);

export type CheckboxVariants = VariantProps<typeof checkboxVariants>;

@Component({
  selector: 'hlm-checkbox',
  standalone: true,
  imports: [NgIcon],
  providers: [
    provideIcons({ lucideCheck }),
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => HlmCheckbox),
      multi: true,
    },
  ],
  template: `
    <label class="inline-flex cursor-pointer select-none items-center gap-2 text-sm text-brand-800">
      <span [class]="boxClasses()">
        <input
          type="checkbox"
          class="sr-only"
          [checked]="checked()"
          [disabled]="disabled()"
          (change)="onInputChange($event)"
          (blur)="onBlur()"
          [attr.aria-label]="ariaLabel() || null"
        />
        @if (checked()) {
          <ng-icon name="lucideCheck" class="text-[10px] leading-none" />
        }
      </span>
      @if (label()) {
        <span class="leading-snug">{{ label() }}</span>
      }
      <ng-content />
    </label>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HlmCheckbox implements ControlValueAccessor {
  public readonly size = input<CheckboxVariants['size']>('default');
  public readonly checked = model<boolean>(false);
  public readonly label = input<string>('');
  public readonly ariaLabel = input<string>('', { alias: 'aria-label' });
  public readonly extraClass = input<string>('', { alias: 'class' });

  /**
   * Emits on USER-initiated changes only — not on programmatic
   * `writeValue` from the FormControl.
   */
  public readonly change = output<boolean>();

  protected readonly disabled = signal<boolean>(false);

  protected readonly boxClasses = computed(() =>
    twMerge(
      checkboxVariants({ size: this.size(), checked: this.checked() }),
      this.extraClass(),
    ),
  );

  private _onChange: (value: boolean) => void = () => {};
  private _onTouched: () => void = () => {};

  writeValue(value: boolean | null | undefined): void {
    this.checked.set(Boolean(value));
  }

  registerOnChange(fn: (value: boolean) => void): void {
    this._onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this._onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected onInputChange(event: Event): void {
    const next = (event.target as HTMLInputElement).checked;
    this.checked.set(next);
    this._onChange(next);
    this.change.emit(next);
  }

  protected onBlur(): void {
    this._onTouched();
  }
}
