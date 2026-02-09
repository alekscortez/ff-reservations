import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { EventsService } from '../../../core/http/events.service';
import { CreateEventPayload, EventItem } from '../../../shared/models/event.model';

@Component({
  selector: 'app-events',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './events.html',
  styleUrl: './events.scss',
})
export class Events implements OnInit {
  private eventsApi = inject(EventsService);

  items: EventItem[] = [];
  loading = false;
  error: string | null = null;
  editingId: string | null = null;

  form = new FormGroup({
    eventName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    eventDate: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    minDeposit: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
  });

  editForm = new FormGroup({
    eventName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    eventDate: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    minDeposit: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    status: new FormControl<'ACTIVE' | 'INACTIVE'>('ACTIVE', { nonNullable: true }),
  });

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

  createEvent(): void {
    if (this.form.invalid) return;
    this.loading = true;
    this.error = null;

    const payload: CreateEventPayload = {
      eventName: this.form.controls.eventName.value.trim(),
      eventDate: this.form.controls.eventDate.value,
      minDeposit: this.form.controls.minDeposit.value,
    };

    this.eventsApi.createEvent(payload).subscribe({
      next: (item) => {
        this.items = [item, ...this.items].sort((a, b) =>
          (a.eventDate || '').localeCompare(b.eventDate || '')
        );
        this.form.reset({ eventName: '', eventDate: '', minDeposit: 0 });
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to create event';
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
  }

  cancelEdit(): void {
    this.editingId = null;
  }

  saveEdit(): void {
    if (!this.editingId) return;
    if (this.editForm.invalid) return;

    this.loading = true;
    this.error = null;

    const patch: Partial<EventItem> = {
      eventName: this.editForm.controls.eventName.value.trim(),
      eventDate: this.editForm.controls.eventDate.value,
      minDeposit: this.editForm.controls.minDeposit.value,
      status: this.editForm.controls.status.value,
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
        this.loading = false;
      },
    });
  }

  deleteEvent(item: EventItem): void {
    const ok = window.confirm(`Delete event ${item.eventName} (${item.eventDate})?`);
    if (!ok) return;

    this.loading = true;
    this.error = null;
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
}
