import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'systemActorLabel',
  standalone: true,
})
export class SystemActorLabelPipe implements PipeTransform {
  transform(value: unknown): string {
    const actor = String(value ?? '').trim();
    if (!actor) return 'System';

    const normalized = actor.toLowerCase();
    if (normalized === 'system:square-webhook') return 'Square System';
    if (normalized.startsWith('system:')) return 'System';

    return actor;
  }
}
