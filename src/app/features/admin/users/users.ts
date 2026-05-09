import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminUser, UsersService } from '../../../core/http/users.service';

@Component({
  selector: 'app-users',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './users.html',
  styleUrl: './users.scss',
})
export class Users implements OnInit {
  private usersApi = inject(UsersService);

  items: AdminUser[] = [];
  loading = false;
  loadingMore = false;
  createLoading = false;
  error: string | null = null;
  notice: string | null = null;
  nextToken: string | null = null;
  actionLoadingByUsername: Record<string, boolean> = {};

  filterQuery = new FormControl('', { nonNullable: true });
  createForm = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    role: new FormControl<'Admin' | 'Staff'>('Staff', { nonNullable: true }),
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error = null;
    this.notice = null;
    this.usersApi.list(50).subscribe({
      next: (res) => {
        this.items = this.sortUsers(res.items ?? []);
        this.nextToken = res.nextToken ?? null;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to load users';
        this.loading = false;
      },
    });
  }

  loadMore(): void {
    if (!this.nextToken || this.loadingMore) return;
    this.loadingMore = true;
    this.error = null;
    this.usersApi.list(50, this.nextToken).subscribe({
      next: (res) => {
        const merged = [...this.items, ...(res.items ?? [])];
        this.items = this.sortUsers(
          merged.filter(
            (item, index, arr) =>
              index === arr.findIndex((other) => other.username === item.username)
          )
        );
        this.nextToken = res.nextToken ?? null;
        this.loadingMore = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to load more users';
        this.loadingMore = false;
      },
    });
  }

  createUser(): void {
    if (this.createForm.invalid) {
      this.createForm.markAllAsTouched();
      return;
    }
    this.createLoading = true;
    this.error = null;
    this.notice = null;
    const payload = {
      name: this.createForm.controls.name.value.trim() || undefined,
      email: this.createForm.controls.email.value.trim().toLowerCase(),
      role: this.createForm.controls.role.value,
    };

    this.usersApi.create(payload).subscribe({
      next: (item) => {
        this.items = this.sortUsers([item, ...this.items]);
        this.createLoading = false;
        this.createForm.reset({
          name: '',
          email: '',
          role: 'Staff',
        });
        this.notice = `Invitation sent to ${item.email ?? payload.email}.`;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to create user';
        this.createLoading = false;
      },
    });
  }

  onRoleChange(user: AdminUser, event: Event): void {
    const username = String(user.username ?? '').trim();
    if (!username) return;
    const selected = String((event.target as HTMLSelectElement | null)?.value ?? '').trim();
    if (selected !== 'Admin' && selected !== 'Staff') return;
    if (user.role === selected) return;
    if (this.actionLoadingByUsername[username]) return;

    this.setActionLoading(username, true);
    this.error = null;
    this.notice = null;
    this.usersApi.updateRole(username, selected).subscribe({
      next: (updated) => {
        this.replaceItem(updated);
        this.setActionLoading(username, false);
        this.notice = `${updated.email ?? updated.username ?? 'User'} role updated to ${updated.role}.`;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to update user role';
        this.setActionLoading(username, false);
      },
    });
  }

  toggleStatus(user: AdminUser): void {
    const username = String(user.username ?? '').trim();
    if (!username) return;
    if (this.actionLoadingByUsername[username]) return;
    const nextEnabled = !user.enabled;

    this.setActionLoading(username, true);
    this.error = null;
    this.notice = null;
    this.usersApi.updateStatus(username, nextEnabled).subscribe({
      next: (updated) => {
        this.replaceItem(updated);
        this.setActionLoading(username, false);
        this.notice = `${updated.email ?? updated.username ?? 'User'} ${updated.enabled ? 'enabled' : 'disabled'}.`;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to update user status';
        this.setActionLoading(username, false);
      },
    });
  }

  sendPasswordReset(user: AdminUser): void {
    const username = String(user.username ?? '').trim();
    if (!username) return;
    if (this.actionLoadingByUsername[username]) return;
    const label = String(user.email ?? user.name ?? username).trim();
    const ok = window.confirm(`Send password reset to ${label}?`);
    if (!ok) return;

    this.setActionLoading(username, true);
    this.error = null;
    this.notice = null;
    this.usersApi.resetPassword(username).subscribe({
      next: (res) => {
        if (res?.item) this.replaceItem(res.item);
        this.setActionLoading(username, false);
        this.notice =
          res?.message ||
          `Password reset requested for ${label}.`;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to send password reset';
        this.setActionLoading(username, false);
      },
    });
  }

  filteredItems(): AdminUser[] {
    const q = this.filterQuery.value.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter((item) => {
      const name = String(item.name ?? '').toLowerCase();
      const email = String(item.email ?? '').toLowerCase();
      const username = String(item.username ?? '').toLowerCase();
      const role = String(item.role ?? '').toLowerCase();
      const status = String(item.status ?? '').toLowerCase();
      return (
        name.includes(q) ||
        email.includes(q) ||
        username.includes(q) ||
        role.includes(q) ||
        status.includes(q)
      );
    });
  }

  roleBadgeClasses(role: string | null | undefined): string {
    const normalized = String(role ?? '').trim().toUpperCase();
    if (normalized === 'ADMIN') return 'bg-danger-100 text-danger-800 border-danger-200';
    if (normalized === 'STAFF') return 'bg-success-100 text-success-800 border-success-200';
    return 'bg-brand-100 text-brand-700 border-brand-200';
  }

  statusBadgeClasses(enabled: boolean): string {
    return enabled
      ? 'bg-success-100 text-success-800 border-success-200'
      : 'bg-brand-100 text-brand-700 border-brand-200';
  }

  formatDateTime(epochSeconds: number | null | undefined): string {
    const value = Number(epochSeconds ?? 0);
    if (!Number.isFinite(value) || value <= 0) return '—';
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  isActionLoading(user: AdminUser): boolean {
    const username = String(user.username ?? '').trim();
    return !!(username && this.actionLoadingByUsername[username]);
  }

  trackByUsername(_index: number, item: AdminUser): string {
    return String(item.username ?? _index);
  }

  private setActionLoading(username: string, loading: boolean): void {
    this.actionLoadingByUsername = {
      ...this.actionLoadingByUsername,
      [username]: loading,
    };
  }

  private replaceItem(updated: AdminUser): void {
    const username = String(updated.username ?? '').trim();
    if (!username) return;
    this.items = this.sortUsers(
      this.items.map((item) => {
        if (item.username !== username) return item;
        return updated;
      })
    );
  }

  private sortUsers(items: AdminUser[]): AdminUser[] {
    return [...(items ?? [])].sort((a, b) => {
      const aRole = String(a.role ?? '');
      const bRole = String(b.role ?? '');
      if (aRole !== bRole) {
        const rank = (role: string) => (role === 'Admin' ? 0 : role === 'Staff' ? 1 : 2);
        return rank(aRole) - rank(bRole);
      }
      const aLabel = String(a.name ?? a.email ?? a.username ?? '').toLowerCase();
      const bLabel = String(b.name ?? b.email ?? b.username ?? '').toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
  }
}
