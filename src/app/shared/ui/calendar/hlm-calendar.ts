import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronLeft, lucideChevronRight } from '@ng-icons/lucide';
import {
  BrnCalendar,
  BrnCalendarCell,
  BrnCalendarCellButton,
  BrnCalendarGrid,
  BrnCalendarHeader,
  BrnCalendarNextButton,
  BrnCalendarPreviousButton,
  BrnCalendarRange,
  BrnCalendarWeek,
  BrnCalendarWeekday,
  injectBrnCalendar,
  injectBrnCalendarI18n,
} from '@spartan-ng/brain/calendar';
import { injectDateAdapter, provideNativeDateAdapter } from '@spartan-ng/brain/date-time';
import { twMerge } from 'tailwind-merge';
import { HlmButton } from '../button';
import { HlmCalendarCellButton } from './hlm-calendar-cell-button';

/**
 * Inner chrome — header bar + weekday row + 6-week grid. Injects the
 * host calendar (BrnCalendar | BrnCalendarRange) so a single template
 * serves both single-date and range-mode wrappers.
 *
 * Brn handles: date arithmetic, selection, range state, keyboard nav
 * (arrows + Home/End + PageUp/PageDown via BrnCalendarCellButton).
 * We handle: visual chrome and per-cell state classes.
 */
@Component({
  selector: 'hlm-calendar-chrome',
  standalone: true,
  imports: [
    CommonModule,
    NgIcon,
    HlmButton,
    BrnCalendarHeader,
    BrnCalendarPreviousButton,
    BrnCalendarNextButton,
    BrnCalendarGrid,
    BrnCalendarWeek,
    BrnCalendarWeekday,
    BrnCalendarCell,
    BrnCalendarCellButton,
    HlmCalendarCellButton,
  ],
  template: `
    <div class="mb-3 flex items-center justify-between">
      <button
        hlmBtn
        brnCalendarPreviousButton
        variant="ghost"
        size="icon-sm"
        type="button"
      >
        <ng-icon name="lucideChevronLeft" class="text-base" />
      </button>
      <h2 brnCalendarHeader class="text-sm font-semibold text-brand-900">
        {{ headerLabel() }}
      </h2>
      <button
        hlmBtn
        brnCalendarNextButton
        variant="ghost"
        size="icon-sm"
        type="button"
      >
        <ng-icon name="lucideChevronRight" class="text-base" />
      </button>
    </div>

    <div brnCalendarGrid>
      <div class="mb-1 grid grid-cols-7">
        <span
          *brnCalendarWeekday="let weekday"
          class="text-center text-[11px] font-medium uppercase tracking-wide text-brand-500"
          aria-hidden="true"
        >
          {{ weekdayLabel(weekday) }}
        </span>
      </div>
      <div *brnCalendarWeek="let week" class="grid grid-cols-7">
        <div brnCalendarCell *ngFor="let day of week; trackBy: trackByDay">
          <button
            brnCalendarCellButton
            hlmCalendarCellButton
            [date]="day"
            type="button"
          >
            {{ dayNumber(day) }}
          </button>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HlmCalendarChrome {
  private readonly _i18n = injectBrnCalendarI18n();
  private readonly _calendar = injectBrnCalendar<Date>();
  private readonly _adapter = injectDateAdapter<Date>();

  protected readonly headerLabel = computed(() => {
    const focused = this._calendar.focusedDate();
    const cfg = this._i18n.config();
    return cfg.formatHeader(this._adapter.getMonth(focused), this._adapter.getYear(focused));
  });

  protected weekdayLabel(index: number): string {
    return this._i18n.config().formatWeekdayName(index);
  }

  protected dayNumber(day: Date): number {
    return this._adapter.getDate(day);
  }

  protected trackByDay = (_: number, day: Date): number => this._adapter.getTime(day);
}

/**
 * Spartan-style single-date calendar. Two-way binds `[(date)]` to a
 * `Date | undefined` model. Use inside an `<hlm-date-picker>` popover,
 * or standalone for an always-visible calendar.
 *
 * @example
 *   <hlm-calendar [(date)]="selected" [min]="minDate" [max]="maxDate" />
 *
 * Forwarded inputs (via hostDirective BrnCalendar):
 *   min, max, disabled, date, dateDisabled, weekStartsOn, defaultFocusedDate
 *
 * Output: dateChange (emitted on cell click)
 */
@Component({
  selector: 'hlm-calendar',
  standalone: true,
  imports: [HlmCalendarChrome],
  template: `<hlm-calendar-chrome />`,
  hostDirectives: [
    {
      directive: BrnCalendar,
      inputs: [
        'min',
        'max',
        'disabled',
        'date',
        'dateDisabled',
        'weekStartsOn',
        'defaultFocusedDate',
      ],
      outputs: ['dateChange'],
    },
  ],
  providers: [
    provideNativeDateAdapter(),
    provideIcons({ lucideChevronLeft, lucideChevronRight }),
  ],
  host: {
    '[class]': 'classes()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HlmCalendar {
  public readonly extraClass = input<string>('', { alias: 'class' });

  protected readonly classes = computed(() =>
    twMerge('block min-w-[18rem] rounded-md bg-white p-3', this.extraClass()),
  );
}

/**
 * Spartan-style range calendar. Two-way binds `[(startDate)]` +
 * `[(endDate)]`. Click cycle: 1st click sets start, 2nd sets end,
 * 3rd resets to start.
 *
 * @example
 *   <hlm-calendar-range [(startDate)]="from" [(endDate)]="to" />
 *
 * Forwarded inputs (via hostDirective BrnCalendarRange):
 *   min, max, disabled, dateDisabled, weekStartsOn, defaultFocusedDate,
 *   startDate, endDate
 *
 * Outputs: startDateChange, endDateChange
 */
@Component({
  selector: 'hlm-calendar-range',
  standalone: true,
  imports: [HlmCalendarChrome],
  template: `<hlm-calendar-chrome />`,
  hostDirectives: [
    {
      directive: BrnCalendarRange,
      inputs: [
        'min',
        'max',
        'disabled',
        'dateDisabled',
        'weekStartsOn',
        'defaultFocusedDate',
        'startDate',
        'endDate',
      ],
      outputs: ['startDateChange', 'endDateChange'],
    },
  ],
  providers: [
    provideNativeDateAdapter(),
    provideIcons({ lucideChevronLeft, lucideChevronRight }),
  ],
  host: {
    '[class]': 'classes()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HlmCalendarRange {
  public readonly extraClass = input<string>('', { alias: 'class' });

  protected readonly classes = computed(() =>
    twMerge('block min-w-[18rem] rounded-md bg-white p-3', this.extraClass()),
  );
}
