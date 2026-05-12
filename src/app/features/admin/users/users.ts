import { CommonModule } from '@angular/common';
import {
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideEllipsis } from '@ng-icons/lucide';
import {
  type ColumnDef,
  type PaginationState,
  type SortingState,
  type VisibilityState,
  createAngularTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
} from '@tanstack/angular-table';
import { AdminUser, UsersService } from '../../../core/http/users.service';
import { HlmButton } from '../../../shared/ui/button';
import { HlmBadge, type BadgeVariants } from '../../../shared/ui/badge';
import { HlmConfirmDialog } from '../../../shared/ui/dialog';
import { HlmInput } from '../../../shared/ui/input';
import {
  HlmMenu,
  HlmMenuCheckbox,
  HlmMenuItem,
  HlmMenuTrigger,
} from '../../../shared/ui/dropdown-menu';
import { HlmNumberedPagination } from '../../../shared/ui/pagination';
import {
  HlmTable,
  HlmTBody,
  HlmTHead,
  HlmTableContainer,
  HlmTableSortHeader,
  HlmTd,
  HlmTh,
  HlmTr,
} from '../../../shared/ui/table';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-users',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    NgIcon,
    HlmButton,
    HlmBadge,
    HlmConfirmDialog,
    HlmInput,
    HlmMenu,
    HlmMenuCheckbox,
    HlmMenuItem,
    HlmMenuTrigger,
    HlmNumberedPagination,
    HlmTable,
    HlmTBody,
    HlmTHead,
    HlmTableContainer,
    HlmTableSortHeader,
    HlmTd,
    HlmTh,
    HlmTr,
  ],
  providers: [provideIcons({ lucideChevronDown, lucideEllipsis })],
  templateUrl: './users.html',
  styleUrl: './users.scss',
})
export class Users implements OnInit {
  private usersApi = inject(UsersService);

  readonly items = signal<AdminUser[]>([]);
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

  private readonly query = toSignal(this.filterQuery.valueChanges, { initialValue: '' });
  readonly sorting = signal<SortingState>([{ id: 'role', desc: false }]);
  readonly pagination = signal<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE });
  readonly columnVisibility = signal<VisibilityState>({});

  readonly hidableColumnIds: ReadonlyArray<string> = [
    'name',
    'email',
    'role',
    'status',
    'updated',
  ];

  private readonly columnLabels: Record<string, string> = {
    name: 'Name',
    email: 'Email',
    role: 'Role',
    status: 'Status',
    updated: 'Updated',
  };

  private readonly tableColumns: ColumnDef<AdminUser>[] = [
    {
      id: 'name',
      accessorFn: (u) => u.name ?? u.username ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'email',
      accessorFn: (u) => u.email ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'role',
      accessorFn: (u) => u.role ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'status',
      accessorFn: (u) => (u.enabled ? 'enabled' : 'disabled'),
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'updated',
      accessorFn: (u) => Number(u.updatedAt ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    { id: 'actions', enableSorting: false },
  ];

  readonly table = createAngularTable<AdminUser>(() => ({
    data: this.items(),
    columns: this.tableColumns,
    state: {
      sorting: this.sorting(),
      globalFilter: this.query(),
      pagination: this.pagination(),
      columnVisibility: this.columnVisibility(),
    },
    onSortingChange: (u) => {
      const next = typeof u === 'function' ? u(this.sorting()) : u;
      this.sorting.set(next);
    },
    onPaginationChange: (u) => {
      const next = typeof u === 'function' ? u(this.pagination()) : u;
      this.pagination.set(next);
    },
    onColumnVisibilityChange: (u) => {
      const next = typeof u === 'function' ? u(this.columnVisibility()) : u;
      this.columnVisibility.set(next);
    },
    globalFilterFn: (row, _id, filterValue: string) => {
      const q = String(filterValue ?? '').trim().toLowerCase();
      if (!q) return true;
      const u = row.original;
      return Boolean(
        (u.name || '').toLowerCase().includes(q) ||
          (u.email || '').toLowerCase().includes(q) ||
          (u.username || '').toLowerCase().includes(q) ||
          (u.role || '').toLowerCase().includes(q) ||
          (u.status || '').toLowerCase().includes(q),
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  }));

  readonly currentRows = computed(() =>
    this.table.getRowModel().rows.map((r) => r.original),
  );
  readonly totalFiltered = computed(() => this.table.getFilteredRowModel().rows.length);
  readonly currentPage = computed(() => this.pagination().pageIndex + 1);
  readonly pageSize = computed(() => this.pagination().pageSize);
  readonly pageStart = computed(() =>
    this.totalFiltered() === 0
      ? 0
      : this.pagination().pageIndex * this.pagination().pageSize + 1,
  );
  readonly pageEnd = computed(() =>
    Math.min(
      (this.pagination().pageIndex + 1) * this.pagination().pageSize,
      this.totalFiltered(),
    ),
  );
  readonly visibleColumnCount = computed(
    () => this.hidableColumnIds.filter((id) => this.isColumnVisible(id)).length + 1,
  );

  constructor() {
    effect(() => {
      this.query();
      this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
    });
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.error = null;
    this.notice = null;
    this.usersApi.list(50).subscribe({
      next: (res) => {
        this.items.set(this.sortUsers(res.items ?? []));
        this.nextToken = res.nextToken ?? null;
        this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
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
        const merged = [...this.items(), ...(res.items ?? [])];
        this.items.set(
          this.sortUsers(
            merged.filter(
              (item, index, arr) =>
                index === arr.findIndex((other) => other.username === item.username),
            ),
          ),
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
        this.items.set(this.sortUsers([item, ...this.items()]));
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

  resetUserTarget: AdminUser | null = null;

  sendPasswordReset(user: AdminUser): void {
    const username = String(user.username ?? '').trim();
    if (!username) return;
    if (this.actionLoadingByUsername[username]) return;
    this.resetUserTarget = user;
  }

  resetUserTargetLabel(): string {
    const u = this.resetUserTarget;
    if (!u) return '';
    return String(u.email ?? u.name ?? u.username ?? '').trim();
  }

  cancelResetUser(): void {
    this.resetUserTarget = null;
  }

  confirmResetUser(): void {
    const user = this.resetUserTarget;
    if (!user) return;
    const username = String(user.username ?? '').trim();
    if (!username) return;
    const label = this.resetUserTargetLabel();
    this.resetUserTarget = null;

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

  onPageChange(page: number): void {
    this.pagination.update((s) => ({ ...s, pageIndex: Math.max(0, page - 1) }));
  }

  onPageSizeChange(size: number): void {
    this.pagination.update((s) => ({ ...s, pageSize: size, pageIndex: 0 }));
  }

  isColumnVisible(id: string): boolean {
    return this.columnVisibility()[id] !== false;
  }

  toggleColumnVisibility(id: string): void {
    this.columnVisibility.update((s) => ({ ...s, [id]: !this.isColumnVisible(id) }));
  }

  columnLabel(id: string): string {
    return this.columnLabels[id] ?? id;
  }

  column(id: string) {
    return this.table.getColumn(id);
  }

  roleBadgeVariant(role: string | null | undefined): BadgeVariants['variant'] {
    const normalized = String(role ?? '').trim().toUpperCase();
    if (normalized === 'ADMIN') return 'danger';
    if (normalized === 'STAFF') return 'success';
    return 'secondary';
  }

  statusBadgeVariant(enabled: boolean): BadgeVariants['variant'] {
    return enabled ? 'success' : 'secondary';
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
    this.items.set(
      this.sortUsers(
        this.items().map((item) => {
          if (item.username !== username) return item;
          return updated;
        }),
      ),
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
