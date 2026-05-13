import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCalendar } from '@ng-icons/lucide';
import {
  BrnPopover,
  BrnPopoverContent,
  BrnPopoverTrigger,
} from '@spartan-ng/brain/popover';
import { twMerge } from 'tailwind-merge';
import { HlmButton } from '../button';
import { HlmCalendar } from '../calendar';
import { HlmPopoverContent } from '../popover/hlm-popover-content';
import type { Weekday } from '@spartan-ng/brain/calendar';

const defaultFormat = (date: Date): string =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Spartan-style single-date picker. Trigger button shows the formatted
 * date (or placeholder); click opens a popover containing
 * `<hlm-calendar>` with two-way `[(date)]` binding.
 *
 * @example
 *   <hlm-date-range-picker> for a range; otherwise:
 *   <hlm-date-picker [(date)]="picked" placeholder="Pick a date" />
 *
 *   <hlm-date-picker
 *     [(date)]="event.startDate"
 *     [min]="today"
 *     [max]="endOfYear"
 *     [format]="customFormat"
 *   />
 *
 * Trigger label:
 *   - date set    → format(date)
 *   - date unset  → placeholder
 *
 * `format` defaults to `Mon DD, YYYY` via Intl. Pass a function to
 * override (e.g. ISO `YYYY-MM-DD` or localized).
 */
@Component({
  selector: 'hlm-date-picker',
  standalone: true,
  imports: [
    CommonModule,
    NgIcon,
    HlmButton,
    HlmCalendar,
    HlmPopoverContent,
    BrnPopover,
    BrnPopoverTrigger,
    BrnPopoverContent,
  ],
  providers: [provideIcons({ lucideCalendar })],
  template: `
    <brn-popover autoFocus="first-tabbable" sideOffset="6" align="start">
      <button
        type="button"
        hlmBtn
        variant="outline"
        brnPopoverTrigger
        [disabled]="disabled()"
        [class]="triggerClasses()"
      >
        <ng-icon name="lucideCalendar" class="mr-2 text-base text-brand-500" />
        <span [class.text-brand-400]="!date()">{{ label() }}</span>
      </button>
      <ng-template brnPopoverContent>
        <div hlmPopoverContent class="w-auto p-0">
          <hlm-calendar
            [(date)]="date"
            [min]="min()"
            [max]="max()"
            [disabled]="disabled()"
            [dateDisabled]="dateDisabled()"
            [weekStartsOn]="weekStartsOn()"
            [defaultFocusedDate]="defaultFocusedDate()"
          />
        </div>
      </ng-template>
    </brn-popover>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HlmDatePicker {
  public readonly date = model<Date | undefined>(undefined);
  public readonly min = input<Date | undefined>(undefined);
  public readonly max = input<Date | undefined>(undefined);
  public readonly disabled = input<boolean>(false);
  public readonly dateDisabled = input<(date: Date) => boolean>(() => false);
  public readonly weekStartsOn = input<Weekday | undefined>(undefined);
  public readonly defaultFocusedDate = input<Date | undefined>(undefined);
  public readonly placeholder = input<string>('Pick a date');
  public readonly format = input<(date: Date) => string>(defaultFormat);
  public readonly extraClass = input<string>('', { alias: 'class' });

  protected readonly label = computed(() => {
    const d = this.date();
    return d ? this.format()(d) : this.placeholder();
  });

  protected readonly triggerClasses = computed(() =>
    twMerge('w-full justify-start text-left font-normal', this.extraClass()),
  );
}
