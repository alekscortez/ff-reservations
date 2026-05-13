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
import { CommonModule } from '@angular/common';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown } from '@ng-icons/lucide';
import { cva, type VariantProps } from 'class-variance-authority';
import { twMerge } from 'tailwind-merge';

/**
 * Spartan-style wrapper around the native `<select>` element. Uses the
 * platform dropdown UI (familiar on mobile, keyboard-correct, free a11y)
 * but normalizes the visual chrome — Spartan border, focus ring, padding,
 * and a `lucideChevronDown` icon overlay so the closed state looks
 * identical across iOS / Android / desktop browsers.
 *
 * @example
 *   <hlm-native-select [(value)]="role">
 *     <option value="Staff">Staff</option>
 *     <option value="Admin">Admin</option>
 *   </hlm-native-select>
 *
 *   <hlm-native-select size="sm" [formControl]="eventStatus">
 *     <option value="ALL">All</option>
 *     <option value="ACTIVE">Active</option>
 *   </hlm-native-select>
 *
 *   <form [formGroup]="form">
 *     <hlm-native-select formControlName="role">…</hlm-native-select>
 *   </form>
 *
 * Sizes: `default` (h-9) | `sm` (h-8). Override per-instance with
 * `class="..."` (tailwind-merge: consumer wins on conflict).
 *
 * Disable via `[disabled]="true"` (template) or the FormControl's
 * disabled state (CVA-aware).
 */
export const nativeSelectVariants = cva(
  'appearance-none w-full rounded-md border border-brand-200 bg-white text-sm text-brand-900 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-300 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-9 pl-3 pr-8',
        sm: 'h-8 pl-2 pr-7 text-sm',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

export type NativeSelectVariants = VariantProps<typeof nativeSelectVariants>;

@Component({
  selector: 'hlm-native-select',
  standalone: true,
  imports: [CommonModule, NgIcon],
  providers: [
    provideIcons({ lucideChevronDown }),
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => HlmNativeSelect),
      multi: true,
    },
  ],
  template: `
    <div class="relative inline-flex w-full items-center">
      <select
        [class]="classes()"
        [value]="value()"
        [disabled]="disabled()"
        (change)="onSelectChange($event)"
        (blur)="onBlur()"
      >
        <ng-content />
      </select>
      <ng-icon
        name="lucideChevronDown"
        class="pointer-events-none absolute right-2 text-base text-brand-500"
      />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HlmNativeSelect implements ControlValueAccessor {
  public readonly size = input<NativeSelectVariants['size']>('default');
  public readonly value = model<string>('');
  public readonly extraClass = input<string>('', { alias: 'class' });

  /**
   * Emits on USER-initiated changes only — not on programmatic
   * `writeValue` from the FormControl. Use this when the change
   * handler mutates the form (otherwise valueChange could loop).
   */
  public readonly change = output<string>();

  protected readonly disabled = signal<boolean>(false);

  protected readonly classes = computed(() =>
    twMerge(nativeSelectVariants({ size: this.size() }), this.extraClass()),
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

  protected onSelectChange(event: Event): void {
    const next = (event.target as HTMLSelectElement).value;
    this.value.set(next);
    this._onChange(next);
    this.change.emit(next);
  }

  protected onBlur(): void {
    this._onTouched();
  }
}
