import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ClientsService } from '../../../core/http/clients.service';
import { FrequentClientsService } from '../../../core/http/frequent-clients.service';
import { CrmClient } from '../../../shared/models/client.model';
import {
  inferPhoneCountryFromE164,
  normalizePhoneCountry,
  normalizePhoneToE164,
} from '../../../shared/phone';
import { PhoneDisplayPipe } from '../../../shared/phone-display.pipe';
import { HlmButton } from '../../../shared/ui/button';
import { HlmInput } from '../../../shared/ui/input';
import { HlmNumberedPagination } from '../../../shared/ui/pagination';

const PAGE_SIZE = 50;

@Component({
  selector: 'app-clients',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    PhoneDisplayPipe,
    HlmButton,
    HlmInput,
    HlmNumberedPagination,
  ],
  templateUrl: './clients.html',
  styleUrl: './clients.scss',
})
export class Clients implements OnInit {
  private clientsApi = inject(ClientsService);
  private frequentApi = inject(FrequentClientsService);

  readonly items = signal<CrmClient[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly editingPhone = signal<string | null>(null);
  editPhoneCountry: 'US' | 'MX' = 'US';

  readonly filterQuery = new FormControl('', { nonNullable: true });
  private readonly query = toSignal(this.filterQuery.valueChanges, { initialValue: '' });

  readonly currentPage = signal(1);
  readonly pageSize = signal(PAGE_SIZE);

  readonly filtered = computed<CrmClient[]>(() => {
    const q = (this.query() ?? '').trim().toLowerCase();
    const all = this.items();
    if (!q) return all;
    return all.filter(
      (c) => c.name?.toLowerCase().includes(q) || c.phone?.includes(q),
    );
  });

  readonly totalFiltered = computed(() => this.filtered().length);

  readonly paginated = computed<CrmClient[]>(() => {
    const list = this.filtered();
    const start = (this.currentPage() - 1) * this.pageSize();
    return list.slice(start, start + this.pageSize());
  });

  readonly pageStart = computed(() =>
    this.totalFiltered() === 0 ? 0 : (this.currentPage() - 1) * this.pageSize() + 1,
  );
  readonly pageEnd = computed(() =>
    Math.min(this.currentPage() * this.pageSize(), this.totalFiltered()),
  );

  editForm = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    phone: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    effect(() => {
      // Reset to page 1 whenever the search query changes. Reading
      // `query()` registers the dependency; we only act when the value
      // actually changes (signal equality handles dedupe).
      this.query();
      this.currentPage.set(1);
    });
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.clientsApi.list().subscribe({
      next: (items) => {
        this.items.set(items);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to load clients');
        this.loading.set(false);
      },
    });
  }

  formatMoney(value?: number): string {
    const num = Number(value ?? 0);
    return num.toFixed(2);
  }

  trackByPhone(_: number, item: CrmClient): string {
    return item.phone ?? '';
  }

  startEdit(item: CrmClient): void {
    this.editingPhone.set(item.phone);
    this.editPhoneCountry =
      inferPhoneCountryFromE164(item.phone) ??
      normalizePhoneCountry(item.phoneCountry ?? 'US');
    this.editForm.setValue({
      name: item.name ?? '',
      phone: item.phone ?? '',
    });
  }

  cancelEdit(): void {
    this.editingPhone.set(null);
  }

  saveEdit(): void {
    const editingPhone = this.editingPhone();
    if (!editingPhone) return;
    const phone = normalizePhoneToE164(
      this.editForm.controls.phone.value.trim(),
      normalizePhoneCountry(this.editPhoneCountry),
    );
    if (!phone) {
      this.error.set('Phone must be a valid US or MX number.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    const patch = {
      name: this.editForm.controls.name.value.trim(),
      phone,
      phoneCountry: this.editPhoneCountry,
    };
    this.clientsApi.update(editingPhone, patch).subscribe({
      next: (item) => {
        this.items.update((list) => list.map((x) => (x.phone === editingPhone ? item : x)));
        this.editingPhone.set(null);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to update client');
        this.loading.set(false);
      },
    });
  }

  addToFrequent(item: CrmClient): void {
    const defaultTables = window.prompt('Default tables (e.g. A01, A02):', '');
    if (!defaultTables) return;
    const notes = window.prompt('Notes (optional):', '') || '';
    this.loading.set(true);
    this.error.set(null);
    this.frequentApi
      .create({
        name: item.name ?? 'Unknown',
        phone: item.phone ?? '',
        phoneCountry: item.phoneCountry,
        defaultTableIds: defaultTables
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
        notes: notes.trim(),
      })
      .subscribe({
        next: () => {
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(
            err?.error?.message || err?.message || 'Failed to add frequent client',
          );
          this.loading.set(false);
        },
      });
  }

  deleteClient(item: CrmClient): void {
    const ok = window.confirm(`Delete client ${item.name}?`);
    if (!ok) return;
    this.loading.set(true);
    this.error.set(null);
    this.clientsApi.delete(item.phone ?? '').subscribe({
      next: () => {
        this.items.update((list) => list.filter((x) => x.phone !== item.phone));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to delete client');
        this.loading.set(false);
      },
    });
  }
}
