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
import { HlmCalendarRange } from '../calendar';
import { HlmPopoverContent } from '../popover/hlm-popover-content';
import type { Weekday } from '@spartan-ng/brain/calendar';

const defaultFormat = (date: Date): string =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Spartan-style date-range picker. Trigger button shows a formatted
 * range label; click opens a popover with `<hlm-calendar-range>` and
 * a Reset / cycle-status footer.
 *
 * @example
 *   <hlm-date-range-picker
 *     [(startDate)]="from"
 *     [(endDate)]="to"
 *     placeholder="Select date range"
 *     openEndedLabel="Open"
 *   />
 *
 * Trigger label states:
 *   - no start, no end       → placeholder
 *   - start only             → "Apr 13, 2026 – {openEndedLabel}"
 *   - both set               → "Apr 13, 2026 – May 20, 2026"
 *
 * Selection cycle (handled by BrnCalendarRange):
 *   1. click → sets start, clears end
 *   2. click → sets end (and reorders if before start)
 *   3. click → resets to a new start
 *
 * The `Reset` button clears both signals back to undefined — useful
 * for "no filter" / open-ended-range semantics.
 *
 * The "open-ended" state (start set, end undefined) is intentionally
 * easy to reach: click a start date, then dismiss the popover by
 * clicking outside. The label updates to "{date} – {openEndedLabel}".
 */
@Component({
  selector: 'hlm-date-range-picker',
  standalone: true,
  imports: [
    CommonModule,
    NgIcon,
    HlmButton,
    HlmCalendarRange,
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
        <span [class.text-brand-400]="!startDate()">{{ label() }}</span>
      </button>
      <ng-template brnPopoverContent>
        <div hlmPopoverContent class="w-auto p-0">
          <hlm-calendar-range
            [(startDate)]="startDate"
            [(endDate)]="endDate"
            [min]="min()"
            [max]="max()"
            [disabled]="disabled()"
            [dateDisabled]="dateDisabled()"
            [weekStartsOn]="weekStartsOn()"
            [defaultFocusedDate]="defaultFocusedDate()"
          />
          <div class="-mx-3 -mb-3 mt-2 flex items-center justify-between border-t border-brand-100 px-3 py-2">
            <button
              type="button"
              hlmBtn
              variant="ghost"
              size="sm"
              (click)="reset()"
              [disabled]="!startDate() && !endDate()"
            >
              Reset
            </button>
            <span class="text-xs text-brand-500">{{ statusHint() }}</span>
          </div>
        </div>
      </ng-template>
    </brn-popover>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HlmDateRangePicker {
  public readonly startDate = model<Date | undefined>(undefined);
  public readonly endDate = model<Date | undefined>(undefined);
  public readonly min = input<Date | undefined>(undefined);
  public readonly max = input<Date | undefined>(undefined);
  public readonly disabled = input<boolean>(false);
  public readonly dateDisabled = input<(date: Date) => boolean>(() => false);
  public readonly weekStartsOn = input<Weekday | undefined>(undefined);
  public readonly defaultFocusedDate = input<Date | undefined>(undefined);
  public readonly placeholder = input<string>('Select date range');
  public readonly openEndedLabel = input<string>('Open');
  public readonly format = input<(date: Date) => string>(defaultFormat);
  public readonly extraClass = input<string>('', { alias: 'class' });

  protected readonly label = computed(() => {
    const s = this.startDate();
    const e = this.endDate();
    const fmt = this.format();
    if (!s && !e) return this.placeholder();
    if (s && !e) return `${fmt(s)} – ${this.openEndedLabel()}`;
    if (!s && e) return `${this.openEndedLabel()} – ${fmt(e)}`;
    return `${fmt(s as Date)} – ${fmt(e as Date)}`;
  });

  protected readonly statusHint = computed(() => {
    const s = this.startDate();
    const e = this.endDate();
    if (!s && !e) return 'Click a date to start';
    if (s && !e) return 'Click a second date for end';
    return 'Click any date to start over';
  });

  protected readonly triggerClasses = computed(() =>
    twMerge('w-full justify-start text-left font-normal', this.extraClass()),
  );

  protected reset(): void {
    this.startDate.set(undefined);
    this.endDate.set(undefined);
  }
}
