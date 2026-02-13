import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { EventsService } from '../../../core/http/events.service';
import { TablesService } from '../../../core/http/tables.service';
import { FrequentClientsService } from '../../../core/http/frequent-clients.service';
import { CreateEventPayload, EventItem } from '../../../shared/models/event.model';
import { TableInfo } from '../../../shared/models/table.model';
import { FrequentClient } from '../../../shared/models/frequent-client.model';

@Component({
  selector: 'app-events',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './events.html',
  styleUrl: './events.scss',
})
export class Events implements OnInit {
  private eventsApi = inject(EventsService);
  private tablesApi = inject(TablesService);
  private frequentApi = inject(FrequentClientsService);

  items: EventItem[] = [];
  loading = false;
  error: string | null = null;
  conflictDate: string | null = null;
  editingId: string | null = null;
  showCreateModal = false;
  templateSections: SectionKey[] = [];
  templateTablesBySection: Record<string, TableInfo[]> = {};

  createDisabled = new Set<string>();
  editDisabled = new Set<string>();
  frequentClients: FrequentClient[] = [];
  createDisabledClients = new Set<string>();
  editDisabledClients = new Set<string>();

  form = new FormGroup({
    eventName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    eventDate: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    minDeposit: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
  });

  filterDate = new FormControl('', { nonNullable: true });
  filterName = new FormControl('', { nonNullable: true });

  createSectionPricing = new FormGroup({
    A: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    B: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    C: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    D: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    E: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
  });

  editForm = new FormGroup({
    eventName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    eventDate: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    minDeposit: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    status: new FormControl<'ACTIVE' | 'INACTIVE'>('ACTIVE', { nonNullable: true }),
  });

  editSectionPricing = new FormGroup({
    A: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    B: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    C: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    D: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    E: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
  });

  ngOnInit(): void {
    this.loadEvents();
    this.loadTemplate();
    this.loadFrequentClients();
  }

  loadEvents(): void {
    this.loading = true;
    this.error = null;
    this.conflictDate = null;
    this.eventsApi.listEvents().subscribe({
      next: (items) => {
        this.items = items.sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || ''));
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.message || 'Failed to load events';
        this.loading = false;
      },
    });
  }

  loadTemplate(): void {
    this.tablesApi.getTemplate().subscribe({
      next: (template) => {
        const sections = Object.keys(template.sections ?? {}).sort() as SectionKey[];
        this.templateSections = sections;
        this.templateTablesBySection = sections.reduce((acc, s) => {
          acc[s] = template.tables.filter((t) => t.section === s);
          return acc;
        }, {} as Record<string, TableInfo[]>);

        for (const s of sections) {
          const price = template.sections[s] ?? 0;
          this.createSectionPricing.controls[s].setValue(price);
          this.editSectionPricing.controls[s].setValue(price);
        }
      },
      error: () => {
        // keep UI usable even if template fails
      },
    });
  }

  loadFrequentClients(): void {
    this.frequentApi.list().subscribe({
      next: (items) => {
        this.frequentClients = items;
      },
      error: () => {
        this.frequentClients = [];
      },
    });
  }

  createEvent(): void {
    if (this.form.invalid) return;
    this.loading = true;
    this.error = null;
    this.conflictDate = null;

    const payload: CreateEventPayload = {
      eventName: this.form.controls.eventName.value.trim(),
      eventDate: this.form.controls.eventDate.value,
      minDeposit: this.form.controls.minDeposit.value,
      sectionPricing: this.sectionPricingValue(this.createSectionPricing.value),
      disabledTables: Array.from(this.createDisabled),
      disabledClients: Array.from(this.createDisabledClients),
    };

    this.eventsApi.createEvent(payload).subscribe({
      next: (item) => {
        this.items = [item, ...this.items].sort((a, b) =>
          (a.eventDate || '').localeCompare(b.eventDate || '')
        );
        this.form.reset({ eventName: '', eventDate: '', minDeposit: 0 });
        this.createDisabled.clear();
        this.createDisabledClients.clear();
        this.showCreateModal = false;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to create event';
        if (err?.status === 409) {
          this.conflictDate = payload.eventDate;
        }
        this.loading = false;
      },
    });
  }

  startEdit(item: EventItem): void {
    this.editingId = item.eventId;
    this.editForm.setValue({
      eventName: item.eventName ?? '',
      eventDate: item.eventDate ?? '',
      minDeposit: item.minDeposit ?? 0,
      status: item.status ?? 'ACTIVE',
    });
    this.editDisabled = new Set(item.disabledTables ?? []);
    this.editDisabledClients = new Set(item.disabledClients ?? []);
    const sp = item.sectionPricing ?? {};
    for (const s of Object.keys(this.editSectionPricing.controls) as SectionKey[]) {
      const current = this.editSectionPricing.controls[s].value;
      const val = sp[s] ?? current;
      this.editSectionPricing.controls[s].setValue(val);
    }
  }

  cancelEdit(): void {
    this.editingId = null;
  }

  openCreateModal(): void {
    this.showCreateModal = true;
    this.error = null;
    this.conflictDate = null;
  }

  closeCreateModal(): void {
    this.showCreateModal = false;
  }

  saveEdit(): void {
    if (!this.editingId) return;
    if (this.editForm.invalid) return;

    this.loading = true;
    this.error = null;
    this.conflictDate = null;

    const patch: Partial<EventItem> = {
      eventName: this.editForm.controls.eventName.value.trim(),
      eventDate: this.editForm.controls.eventDate.value,
      minDeposit: this.editForm.controls.minDeposit.value,
      status: this.editForm.controls.status.value,
      sectionPricing: this.sectionPricingValue(this.editSectionPricing.value),
      disabledTables: Array.from(this.editDisabled),
      disabledClients: Array.from(this.editDisabledClients),
    };

    this.eventsApi.updateEvent(this.editingId, patch).subscribe({
      next: (item) => {
        this.items = this.items
          .map((x) => (x.eventId === item.eventId ? item : x))
          .sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || ''));
        this.editingId = null;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to update event';
        if (err?.status === 409) {
          this.conflictDate = patch.eventDate ?? null;
        }
        this.loading = false;
      },
    });
  }

  deleteEvent(item: EventItem): void {
    const ok = window.confirm(`Delete event ${item.eventName} (${item.eventDate})?`);
    if (!ok) return;

    this.loading = true;
    this.error = null;
    this.conflictDate = null;
    this.eventsApi.deleteEvent(item.eventId).subscribe({
      next: () => {
        this.items = this.items.filter((x) => x.eventId !== item.eventId);
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to delete event';
        this.loading = false;
      },
    });
  }

  filteredItems(): EventItem[] {
    const date = this.filterDate.value?.trim();
    const name = this.filterName.value?.trim().toLowerCase();
    return this.items.filter((x) => {
      const matchDate = date ? x.eventDate === date : true;
      const matchName = name ? (x.eventName || '').toLowerCase().includes(name) : true;
      return matchDate && matchName;
    });
  }

  toggleCreateDisabled(id: string): void {
    if (this.createDisabled.has(id)) this.createDisabled.delete(id);
    else this.createDisabled.add(id);
  }

  toggleEditDisabled(id: string): void {
    if (this.editDisabled.has(id)) this.editDisabled.delete(id);
    else this.editDisabled.add(id);
  }

  isCreateDisabled(id: string): boolean {
    return this.createDisabled.has(id);
  }

  isEditDisabled(id: string): boolean {
    return this.editDisabled.has(id);
  }

  toggleCreateDisabledClient(id: string): void {
    if (this.createDisabledClients.has(id)) this.createDisabledClients.delete(id);
    else this.createDisabledClients.add(id);
  }

  toggleEditDisabledClient(id: string): void {
    if (this.editDisabledClients.has(id)) this.editDisabledClients.delete(id);
    else this.editDisabledClients.add(id);
  }

  isCreateDisabledClient(id: string): boolean {
    return this.createDisabledClients.has(id);
  }

  isEditDisabledClient(id: string): boolean {
    return this.editDisabledClients.has(id);
  }

  formatClientTables(client: FrequentClient): string {
    const list = client.defaultTableIds?.length
      ? client.defaultTableIds
      : client.defaultTableId
        ? [client.defaultTableId]
        : [];
    return list.join(', ');
  }

  private sectionPricingValue(value: any): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value ?? {})) {
      const num = Number(v);
      if (Number.isFinite(num)) out[k] = num;
    }
    return out;
  }

  getSectionControl(
    form: FormGroup<{
      A: FormControl<number>;
      B: FormControl<number>;
      C: FormControl<number>;
      D: FormControl<number>;
      E: FormControl<number>;
    }>,
    section: SectionKey
  ): FormControl<number> {
    return form.controls[section];
  }
}

type SectionKey = 'A' | 'B' | 'C' | 'D' | 'E';
