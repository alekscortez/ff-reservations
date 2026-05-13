import { Directive, computed, inject } from '@angular/core';
import { BrnCalendarCellButton } from '@spartan-ng/brain/calendar';

/**
 * Styled day-cell button. Composes alongside `brnCalendarCellButton`
 * on the same `<button>` element — brn handles selection/focus/keyboard
 * nav; this directive reads the brn signals and applies state classes.
 *
 * @example
 *   <button brnCalendarCellButton hlmCalendarCellButton [date]="day">
 *     {{ dayNum(day) }}
 *   </button>
 *
 * State classes (precedence: disabled > selected/range > today > outside):
 * - selected / start / end:  bg-primary, text-primary-foreground
 * - betweenRange (not start/end): bg-primary/10
 * - today (unselected):      ring-1 ring-brand-300
 * - outside (other month):   text-brand-300
 * - disabled:                opacity-50, cursor-not-allowed
 * - default:                 hover:bg-brand-100
 */
@Directive({
  selector: 'button[hlmCalendarCellButton]',
  standalone: true,
  host: {
    '[class]': 'classes()',
  },
})
export class HlmCalendarCellButton {
  private readonly _brn = inject(BrnCalendarCellButton);

  protected readonly classes = computed(() => {
    const selected = this._brn.selected();
    const start = this._brn.start();
    const end = this._brn.end();
    const between = this._brn.betweenRange();
    const today = this._brn.today();
    const outside = this._brn.outside();
    const disabled = this._brn.disabled();

    const parts = [
      'relative inline-flex h-9 w-full items-center justify-center text-sm tabular-nums transition-colors outline-none',
      'focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:z-10',
    ];

    if (selected || start || end) {
      parts.push('bg-primary text-primary-foreground font-medium');
      if (start && !end) parts.push('rounded-l-md');
      else if (end && !start) parts.push('rounded-r-md');
      else parts.push('rounded-md');
    } else if (between) {
      parts.push('bg-primary/10 text-brand-900');
    } else {
      parts.push('rounded-md');
      if (today) parts.push('ring-1 ring-inset ring-brand-300');
      if (outside) parts.push('text-brand-300');
      else parts.push('text-brand-900');
      if (!disabled) parts.push('hover:bg-brand-100');
    }

    if (disabled) parts.push('opacity-40 pointer-events-none');

    return parts.join(' ');
  });
}
