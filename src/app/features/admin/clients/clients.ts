import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ClientsService } from '../../../core/http/clients.service';
import { CrmClient } from '../../../shared/models/client.model';

@Component({
  selector: 'app-clients',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './clients.html',
  styleUrl: './clients.scss',
})
export class Clients implements OnInit {
  private clientsApi = inject(ClientsService);

  items: CrmClient[] = [];
  loading = false;
  error: string | null = null;
  filterQuery = new FormControl('', { nonNullable: true });

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
}
