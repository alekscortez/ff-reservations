import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ClientsService } from '../../../core/http/clients.service';
import { FrequentClientsService } from '../../../core/http/frequent-clients.service';
import { CrmClient } from '../../../shared/models/client.model';

@Component({
  selector: 'app-clients',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './clients.html',
  styleUrl: './clients.scss',
})
export class Clients implements OnInit {
  private clientsApi = inject(ClientsService);
  private frequentApi = inject(FrequentClientsService);

  items: CrmClient[] = [];
  loading = false;
  error: string | null = null;
  filterQuery = new FormControl('', { nonNullable: true });
  editingPhone: string | null = null;

  editForm = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    phone: new FormControl('', { nonNullable: true }),
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error = null;
    this.clientsApi.list().subscribe({
      next: (items) => {
        this.items = items;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to load clients';
        this.loading = false;
      },
    });
  }

  filteredItems(): CrmClient[] {
    const q = this.filterQuery.value.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(
      (c) => c.name?.toLowerCase().includes(q) || c.phone?.includes(q)
    );
  }

  formatMoney(value?: number): string {
    const num = Number(value ?? 0);
    return num.toFixed(2);
  }

  startEdit(item: CrmClient): void {
    this.editingPhone = item.phone;
    this.editForm.setValue({
      name: item.name ?? '',
      phone: item.phone ?? '',
    });
  }

  cancelEdit(): void {
    this.editingPhone = null;
  }

  saveEdit(): void {
    if (!this.editingPhone) return;
    this.loading = true;
    this.error = null;
    const patch = {
      name: this.editForm.controls.name.value.trim(),
      phone: this.editForm.controls.phone.value.trim(),
    };
    this.clientsApi.update(this.editingPhone, patch).subscribe({
      next: (item) => {
        this.items = this.items.map((x) => (x.phone === this.editingPhone ? item : x));
        this.editingPhone = null;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to update client';
        this.loading = false;
      },
    });
  }

  addToFrequent(item: CrmClient): void {
    const defaultTables = window.prompt('Default tables (e.g. A01, A02):', '');
    if (!defaultTables) return;
    const notes = window.prompt('Notes (optional):', '') || '';
    this.loading = true;
    this.error = null;
    this.frequentApi
      .create({
        name: item.name ?? 'Unknown',
        phone: item.phone ?? '',
        defaultTableIds: defaultTables
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
        notes: notes.trim(),
      })
      .subscribe({
        next: () => {
          this.loading = false;
        },
        error: (err) => {
          this.error =
            err?.error?.message || err?.message || 'Failed to add frequent client';
          this.loading = false;
        },
      });
  }

  deleteClient(item: CrmClient): void {
    const ok = window.confirm(`Delete client ${item.name}?`);
    if (!ok) return;
    this.loading = true;
    this.error = null;
    this.clientsApi.delete(item.phone ?? '').subscribe({
      next: () => {
        this.items = this.items.filter((x) => x.phone !== item.phone);
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to delete client';
        this.loading = false;
      },
    });
  }
}
