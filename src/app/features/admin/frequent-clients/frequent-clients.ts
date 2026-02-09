import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { FrequentClientsService } from '../../../core/http/frequent-clients.service';
import { FrequentClient } from '../../../shared/models/frequent-client.model';

@Component({
  selector: 'app-frequent-clients',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './frequent-clients.html',
  styleUrl: './frequent-clients.scss',
})
export class FrequentClients implements OnInit {
  private clientsApi = inject(FrequentClientsService);

  items: FrequentClient[] = [];
  loading = false;
  error: string | null = null;
  editingId: string | null = null;

  form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    defaultTableId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    notes: new FormControl('', { nonNullable: true }),
  });

  editForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    defaultTableId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    notes: new FormControl('', { nonNullable: true }),
    status: new FormControl<'ACTIVE' | 'DISABLED'>('ACTIVE', { nonNullable: true }),
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

  create(): void {
    if (this.form.invalid) return;
    this.loading = true;
    this.error = null;
    this.clientsApi
      .create({
        name: this.form.controls.name.value.trim(),
        phone: this.form.controls.phone.value.trim(),
        defaultTableId: this.form.controls.defaultTableId.value.trim(),
        notes: this.form.controls.notes.value.trim(),
      })
      .subscribe({
        next: (item) => {
          this.items = [item, ...this.items];
          this.form.reset({ name: '', phone: '', defaultTableId: '', notes: '' });
          this.loading = false;
        },
        error: (err) => {
          this.error = err?.error?.message || err?.message || 'Failed to create client';
          this.loading = false;
        },
      });
  }

  startEdit(item: FrequentClient): void {
    this.editingId = item.clientId;
    this.editForm.setValue({
      name: item.name ?? '',
      phone: item.phone ?? '',
      defaultTableId: item.defaultTableId ?? '',
      notes: item.notes ?? '',
      status: item.status ?? 'ACTIVE',
    });
  }

  cancelEdit(): void {
    this.editingId = null;
  }

  saveEdit(): void {
    if (!this.editingId) return;
    if (this.editForm.invalid) return;
    this.loading = true;
    this.error = null;
    const patch = {
      name: this.editForm.controls.name.value.trim(),
      phone: this.editForm.controls.phone.value.trim(),
      defaultTableId: this.editForm.controls.defaultTableId.value.trim(),
      notes: this.editForm.controls.notes.value.trim(),
      status: this.editForm.controls.status.value,
    };
    this.clientsApi.update(this.editingId, patch).subscribe({
      next: (item) => {
        this.items = this.items.map((x) => (x.clientId === item.clientId ? item : x));
        this.editingId = null;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to update client';
        this.loading = false;
      },
    });
  }

  delete(item: FrequentClient): void {
    const ok = window.confirm(`Delete client ${item.name}?`);
    if (!ok) return;
    this.loading = true;
    this.error = null;
    this.clientsApi.delete(item.clientId).subscribe({
      next: () => {
        this.items = this.items.filter((x) => x.clientId !== item.clientId);
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to delete client';
        this.loading = false;
      },
    });
  }
}
