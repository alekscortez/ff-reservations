import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TablesService } from '../../../core/http/tables.service';
import { HoldsService } from '../../../core/http/holds.service';
import { ReservationsService } from '../../../core/http/reservations.service';
import { TableForEvent } from '../../../shared/models/table.model';
import { EventItem } from '../../../shared/models/event.model';

@Component({
  selector: 'app-reservations-new',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './reservations-new.html',
  styleUrl: './reservations-new.scss',
})
export class ReservationsNew implements OnInit {
  private route = inject(ActivatedRoute);
  private tablesApi = inject(TablesService);
  private holdsApi = inject(HoldsService);
  private reservationsApi = inject(ReservationsService);

  eventDate: string | null = null;
  event: EventItem | null = null;
  tables: TableForEvent[] = [];
  loading = false;
  error: string | null = null;

  selectedTable: TableForEvent | null = null;
  selectedTableId: string | null = null;
  holdId: string | null = null;
  sections: string[] = [];

  form = new FormGroup({
    customerName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    depositAmount: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    paymentMethod: new FormControl<'cash' | 'cashapp' | 'square'>('cash', {
      nonNullable: true,
    }),
  });

  filterQuery = new FormControl('', { nonNullable: true });
  filterStatus = new FormControl<'ALL' | 'AVAILABLE' | 'HOLD' | 'RESERVED' | 'DISABLED'>('ALL', {
    nonNullable: true,
  });
  filterSection = new FormControl<string>('ALL', { nonNullable: true });
  onlyAvailable = false;

  ngOnInit(): void {
    this.route.queryParamMap.subscribe((params) => {
      this.eventDate = params.get('date');
      if (this.eventDate) this.loadTables(this.eventDate);
    });
  }

  loadTables(date: string): void {
    this.loading = true;
    this.error = null;
    this.tablesApi.getForEvent(date).subscribe({
      next: (res) => {
        this.event = res.event;
        this.tables = res.tables;
        this.sections = Array.from(new Set(res.tables.map((t) => t.section))).sort();
        if (this.filterSection.value !== 'ALL' && !this.sections.includes(this.filterSection.value)) {
          this.filterSection.setValue('ALL');
        }
        if (this.selectedTableId) {
          this.selectedTable = this.tables.find((t) => t.id === this.selectedTableId) ?? null;
        } else {
          this.selectedTable = null;
        }
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to load tables';
        this.loading = false;
      },
    });
  }

  selectTable(t: TableForEvent): void {
    if (t.status !== 'AVAILABLE') return;
    this.selectedTable = t;
    this.selectedTableId = t.id;
    this.holdId = null;
  }

  createHold(): void {
    if (!this.eventDate || !this.selectedTable) return;
    this.loading = true;
    this.error = null;
    this.holdsApi
      .createHold({
        eventDate: this.eventDate,
        tableId: this.selectedTable.id,
        customerName: this.form.controls.customerName.value,
        phone: this.form.controls.phone.value,
      })
      .subscribe({
        next: (item) => {
          this.holdId = item.holdId;
          this.loading = false;
          this.loadTables(this.eventDate!);
        },
        error: (err) => {
          this.error = err?.error?.message || err?.message || 'Failed to hold table';
          this.loading = false;
        },
      });
  }

  releaseHold(): void {
    if (!this.eventDate || !this.selectedTable) return;
    this.loading = true;
    this.error = null;
    this.holdsApi.releaseHold(this.eventDate, this.selectedTable.id).subscribe({
      next: () => {
        this.holdId = null;
        this.loadTables(this.eventDate!);
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to release hold';
        this.loading = false;
      },
    });
  }

  confirmReservation(): void {
    if (!this.eventDate || !this.selectedTable || !this.holdId) return;
    if (this.form.invalid) return;
    this.loading = true;
    this.error = null;
    this.reservationsApi
      .create({
        eventDate: this.eventDate,
        tableId: this.selectedTable.id,
        holdId: this.holdId,
        customerName: this.form.controls.customerName.value,
        phone: this.form.controls.phone.value,
        depositAmount: this.form.controls.depositAmount.value,
        paymentMethod: this.form.controls.paymentMethod.value,
      })
      .subscribe({
        next: () => {
          this.holdId = null;
          this.selectedTable = null;
          this.selectedTableId = null;
          this.form.reset({ customerName: '', phone: '', depositAmount: 0, paymentMethod: 'cash' });
          this.loadTables(this.eventDate!);
          this.loading = false;
        },
        error: (err) => {
          this.error =
            err?.error?.message || err?.message || 'Failed to confirm reservation';
          this.loading = false;
        },
      });
  }

  filteredTables(): TableForEvent[] {
    const query = this.filterQuery.value.trim().toLowerCase();
    const status = this.onlyAvailable ? 'AVAILABLE' : this.filterStatus.value;
    const section = this.filterSection.value;
    return this.tables.filter((t) => {
      const matchQuery = query ? t.id.toLowerCase().includes(query) : true;
      const matchStatus = status === 'ALL' ? true : t.status === status;
      const matchSection = section === 'ALL' ? true : t.section === section;
      return matchQuery && matchStatus && matchSection;
    });
  }

  toggleOnlyAvailable(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.onlyAvailable = checked;
    if (checked && this.filterStatus.value !== 'AVAILABLE') {
      this.filterStatus.setValue('AVAILABLE');
    }
  }

  tableCounts(): { total: number; available: number; hold: number; reserved: number; disabled: number } {
    const counts = { total: this.tables.length, available: 0, hold: 0, reserved: 0, disabled: 0 };
    for (const t of this.tables) {
      if (t.status === 'AVAILABLE') counts.available += 1;
      if (t.status === 'HOLD') counts.hold += 1;
      if (t.status === 'RESERVED') counts.reserved += 1;
      if (t.status === 'DISABLED') counts.disabled += 1;
    }
    return counts;
  }
}
