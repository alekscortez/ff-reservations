import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { EventsService } from '../../../core/http/events.service';
import { EventItem } from '../../../shared/models/event.model';

@Component({
  selector: 'app-staff-events',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './events.html',
  styleUrl: './events.scss',
})
export class StaffEvents implements OnInit {
  private eventsApi = inject(EventsService);
  private router = inject(Router);

  items: EventItem[] = [];
  loading = false;
  error: string | null = null;
  filterDate = new FormControl('', { nonNullable: true });
  filterName = new FormControl('', { nonNullable: true });

  ngOnInit(): void {
    this.loadEvents();
  }

  loadEvents(): void {
    this.loading = true;
    this.error = null;
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

  filteredItems(): EventItem[] {
    const date = this.filterDate.value?.trim();
    const name = this.filterName.value?.trim().toLowerCase();
    return this.items.filter((x) => {
      const matchDate = date ? x.eventDate === date : true;
      const matchName = name ? (x.eventName || '').toLowerCase().includes(name) : true;
      return matchDate && matchName;
    });
  }

  goToReservations(eventDate: string): void {
    this.router.navigate(['/staff/reservations/new'], {
      queryParams: { date: eventDate },
    });
  }
}
