import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { FrequentClientsService } from '../../../core/http/frequent-clients.service';
import { TablesService } from '../../../core/http/tables.service';
import {
  FrequentClient,
  FrequentClientTableSetting,
  PaymentStatus,
} from '../../../shared/models/frequent-client.model';
import { TableInfo } from '../../../shared/models/table.model';
import {
  inferPhoneCountryFromE164,
  normalizePhoneCountry,
  normalizePhoneToE164,
} from '../../../shared/phone';
import { PhoneDisplayPipe } from '../../../shared/phone-display.pipe';
import { SettingsService } from '../../../core/http/settings.service';

@Component({
  selector: 'app-frequent-clients',
  imports: [CommonModule, ReactiveFormsModule, PhoneDisplayPipe],
  templateUrl: './frequent-clients.html',
  styleUrl: './frequent-clients.scss',
})
export class FrequentClients implements OnInit {
  private clientsApi = inject(FrequentClientsService);
  private tablesApi = inject(TablesService);
  private settingsApi = inject(SettingsService);

  items: FrequentClient[] = [];
  loading = false;
  error: string | null = null;
  editingId: string | null = null;
  templateSections: string[] = [];
  templateTablesBySection: Record<string, TableInfo[]> = {};
  tableInfoById: Record<string, TableInfo> = {};
  tablePriceById: Record<string, number> = {};
  activeSection = '';
  createSelectedTables = new Set<string>();
  editSelectedTables = new Set<string>();
  createTableSettings: Record<string, FrequentClientTableSetting> = {};
  editTableSettings: Record<string, FrequentClientTableSetting> = {};
  editSettings = new FormArray<FormGroup>([]);
  showCreateForm = false;
  filterQuery = new FormControl('', { nonNullable: true });
  paymentStatuses: PaymentStatus[] = ['PENDING', 'PARTIAL', 'PAID', 'COURTESY'];
  defaultDeadlineTime = '00:00';
  defaultDeadlineTz = 'America/Chicago';
  createPhoneCountry: 'US' | 'MX' = 'US';
  editPhoneCountry: 'US' | 'MX' = 'US';

  form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    defaultTableIds: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    notes: new FormControl('', { nonNullable: true }),
  });

  editForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    defaultTableIds: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    notes: new FormControl('', { nonNullable: true }),
    status: new FormControl<'ACTIVE' | 'DISABLED'>('ACTIVE', { nonNullable: true }),
  });

  ngOnInit(): void {
    this.load();
    this.loadTemplate();
    this.loadGlobalTimezone();
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

  filteredItems(): FrequentClient[] {
    const q = this.filterQuery.value.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter((c) => {
      const name = (c.name ?? '').toLowerCase();
      const phone = String(c.phone ?? '').toLowerCase();
      const tables = this.formatTables(c).toLowerCase();
      return name.includes(q) || phone.includes(q) || tables.includes(q);
    });
  }

  loadTemplate(): void {
    this.tablesApi.getTemplate().subscribe({
      next: (template) => {
        const sections = Object.keys(template.sections ?? {}).sort();
        this.templateSections = sections;
        this.activeSection = sections[0] ?? '';
        this.templateTablesBySection = sections.reduce((acc, s) => {
          acc[s] = template.tables.filter((t) => t.section === s);
          return acc;
        }, {} as Record<string, TableInfo[]>);
        this.tableInfoById = template.tables.reduce((acc, t) => {
          acc[t.id] = t;
          return acc;
        }, {} as Record<string, TableInfo>);
        this.tablePriceById = template.tables.reduce((acc, t) => {
          acc[t.id] = t.price;
          return acc;
        }, {} as Record<string, number>);
      },
      error: () => {
        this.templateSections = [];
        this.templateTablesBySection = {};
        this.activeSection = '';
      },
    });
  }

  private loadGlobalTimezone(): void {
    this.settingsApi.getAdminSettings().subscribe({
      next: (settings) => this.applyGlobalDeadlineTimezone(settings.operatingTz),
      error: () => {
        // Keep current default timezone if settings load fails.
      },
    });
  }

  private applyGlobalDeadlineTimezone(timezone: string | null | undefined): void {
    const normalized = String(timezone ?? '').trim();
    if (!normalized) return;
    this.defaultDeadlineTz = normalized;

    for (const tableId of Object.keys(this.createTableSettings)) {
      this.createTableSettings[tableId] = {
        ...this.createTableSettings[tableId],
        paymentDeadlineTz: normalized,
      };
    }

    for (const tableId of Object.keys(this.editTableSettings)) {
      this.editTableSettings[tableId] = {
        ...this.editTableSettings[tableId],
        paymentDeadlineTz: normalized,
      };
    }

    for (const group of this.editSettings.controls) {
      group.controls['paymentDeadlineTz'].setValue(normalized, { emitEvent: false });
    }
  }

  create(): void {
    if (this.form.invalid) return;
    const phone = normalizePhoneToE164(
      this.form.controls.phone.value.trim(),
      normalizePhoneCountry(this.createPhoneCountry)
    );
    if (!phone) {
      this.error = 'Phone must be a valid US or MX number.';
      return;
    }
    this.loading = true;
    this.error = null;
    this.clientsApi
      .create({
        name: this.form.controls.name.value.trim(),
        phone,
        phoneCountry: this.createPhoneCountry,
        defaultTableIds: Array.from(this.createSelectedTables),
        tableSettings: this.serializeSettings(this.createSelectedTables, this.createTableSettings),
        notes: this.form.controls.notes.value.trim(),
      })
      .subscribe({
        next: (item) => {
          this.items = [item, ...this.items];
          this.form.reset({ name: '', phone: '', defaultTableIds: '', notes: '' });
          this.createPhoneCountry = 'US';
          this.createSelectedTables.clear();
          this.createTableSettings = {};
          this.showCreateForm = false;
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
    this.loading = true;
    this.clientsApi.get(item.clientId).subscribe({
      next: (full) => {
        this.applyEditClient(full);
        this.loading = false;
      },
      error: () => {
        this.applyEditClient(item);
        this.loading = false;
      },
    });
  }

  private applyEditClient(item: FrequentClient): void {
    const selected = this.normalizeTableList(item.defaultTableIds ?? item.defaultTableId);
    this.editSelectedTables = new Set(selected);
    this.editTableSettings = {};
    (item.tableSettings ?? []).forEach((setting) => {
      const key = String(setting.tableId ?? '').trim().toUpperCase();
      if (!key) return;
      this.editTableSettings[key] = this.normalizeSetting({ ...setting, tableId: key });
    });
    this.editSettings.clear();
    this.editSelectedTables.forEach((tableId) => {
      this.ensureEditSetting(tableId);
      const setting = this.editTableSettings[tableId];
      if (setting) {
        const group = this.buildSettingGroup(setting);
        group.controls['paymentStatus'].valueChanges.subscribe((status) => {
          const current = group.getRawValue() as FrequentClientTableSetting;
          const next = this.applyRules({
            ...current,
            paymentStatus: status as PaymentStatus,
          });
          group.patchValue(
            {
              amountDue: next.amountDue,
              amountPaid: next.amountPaid ?? 0,
              paymentDeadlineTime: next.paymentDeadlineTime ?? this.defaultDeadlineTime,
              paymentDeadlineTz: next.paymentDeadlineTz ?? this.defaultDeadlineTz,
            },
            { emitEvent: false }
          );
        });
        this.editSettings.push(group);
      }
    });
    this.editForm.setValue({
      name: item.name ?? '',
      phone: item.phone ?? '',
      defaultTableIds: this.formatTables(item),
      notes: item.notes ?? '',
      status: item.status ?? 'ACTIVE',
    });
    this.editPhoneCountry =
      inferPhoneCountryFromE164(item.phone) ??
      normalizePhoneCountry(item.phoneCountry ?? 'US');
  }

  cancelEdit(): void {
    this.editingId = null;
  }

  saveEdit(): void {
    if (!this.editingId) return;
    if (this.editForm.invalid) return;
    const phone = normalizePhoneToE164(
      this.editForm.controls.phone.value.trim(),
      normalizePhoneCountry(this.editPhoneCountry)
    );
    if (!phone) {
      this.error = 'Phone must be a valid US or MX number.';
      return;
    }
    this.loading = true;
    this.error = null;
    const settings = this.editSettings.controls.map((group) => {
      const raw = group.getRawValue() as FrequentClientTableSetting;
      return this.applyRules({
        tableId: String(raw.tableId ?? '').trim().toUpperCase(),
        paymentStatus: raw.paymentStatus,
        amountDue: Number(raw.amountDue ?? 0),
        amountPaid: Number(raw.amountPaid ?? 0),
        paymentDeadlineTime: raw.paymentDeadlineTime,
        paymentDeadlineTz: raw.paymentDeadlineTz,
      });
    });
    const tableIds = settings.map((s) => s.tableId);
    const patch = {
      name: this.editForm.controls.name.value.trim(),
      phone,
      phoneCountry: this.editPhoneCountry,
      defaultTableIds: tableIds,
      tableSettings: settings,
      notes: this.editForm.controls.notes.value.trim(),
      status: this.editForm.controls.status.value,
    };
    this.clientsApi.update(this.editingId, patch).subscribe({
      next: (item) => {
        this.items = this.items.map((x) => (x.clientId === item.clientId ? item : x));
        this.editingId = null;
        this.load();
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

  toggleCreateForm(): void {
    this.showCreateForm = !this.showCreateForm;
  }

  toggleSection(section: string): void {
    this.activeSection = section;
  }

  toggleCreateTable(id: string): void {
    if (this.createSelectedTables.has(id)) {
      this.createSelectedTables.delete(id);
      delete this.createTableSettings[id];
    } else {
      this.createSelectedTables.add(id);
      this.ensureCreateSetting(id);
    }
    this.form.controls.defaultTableIds.setValue(Array.from(this.createSelectedTables).join(', '));
  }

  toggleEditTable(id: string): void {
    if (this.editSelectedTables.has(id)) {
      this.editSelectedTables.delete(id);
      delete this.editTableSettings[id];
      const idx = this.findEditSettingIndex(id);
      if (idx >= 0) this.editSettings.removeAt(idx);
    } else {
      this.editSelectedTables.add(id);
      this.ensureEditSetting(id);
      const setting = this.editTableSettings[id];
      if (setting) {
        const group = this.buildSettingGroup(setting);
        group.controls['paymentStatus'].valueChanges.subscribe((status) => {
          const current = group.getRawValue() as FrequentClientTableSetting;
          const next = this.applyRules({
            ...current,
            paymentStatus: status as PaymentStatus,
          });
          group.patchValue(
            {
              amountDue: next.amountDue,
              amountPaid: next.amountPaid ?? 0,
              paymentDeadlineTime: next.paymentDeadlineTime ?? this.defaultDeadlineTime,
              paymentDeadlineTz: next.paymentDeadlineTz ?? this.defaultDeadlineTz,
            },
            { emitEvent: false }
          );
        });
        this.editSettings.push(group);
      }
    }
    this.editForm.controls.defaultTableIds.setValue(Array.from(this.editSelectedTables).join(', '));
  }

  isCreateSelected(id: string): boolean {
    return this.createSelectedTables.has(id);
  }

  isEditSelected(id: string): boolean {
    return this.editSelectedTables.has(id);
  }

  removeCreateTable(id: string): void {
    this.createSelectedTables.delete(id);
    delete this.createTableSettings[id];
    this.form.controls.defaultTableIds.setValue(Array.from(this.createSelectedTables).join(', '));
  }

  removeEditTable(id: string): void {
    this.editSelectedTables.delete(id);
    delete this.editTableSettings[id];
    const idx = this.findEditSettingIndex(id);
    if (idx >= 0) this.editSettings.removeAt(idx);
    this.editForm.controls.defaultTableIds.setValue(Array.from(this.editSelectedTables).join(', '));
  }

  formatTables(item: FrequentClient): string {
    const list = this.normalizeTableList(item.defaultTableIds ?? item.defaultTableId);
    return list.join(', ');
  }

  private normalizeTableList(value: string[] | string | undefined): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map((v) => String(v).trim().toUpperCase())
        .filter(Boolean);
    }
    return value
      .split(',')
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean);
  }

  toNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  get createSelectedList(): string[] {
    return Array.from(this.createSelectedTables).sort();
  }

  get editSelectedList(): string[] {
    return Array.from(this.editSelectedTables).sort();
  }

  getTableInfo(id: string): TableInfo | undefined {
    return this.tableInfoById[id];
  }

  getCreateSetting(tableId: string): FrequentClientTableSetting {
    this.ensureCreateSetting(tableId);
    return this.createTableSettings[tableId];
  }

  getEditSetting(tableId: string): FrequentClientTableSetting {
    this.ensureEditSetting(tableId);
    return this.editTableSettings[tableId];
  }

  updateCreateSetting(tableId: string, patch: Partial<FrequentClientTableSetting>): void {
    const current = this.getCreateSetting(tableId);
    this.createTableSettings[tableId] = this.applyRules({ ...current, ...patch });
  }

  updateEditSetting(tableId: string, patch: Partial<FrequentClientTableSetting>): void {
    const current = this.getEditSetting(tableId);
    this.editTableSettings[tableId] = this.applyRules({ ...current, ...patch });
  }

  private ensureCreateSetting(tableId: string): void {
    if (this.createTableSettings[tableId]) return;
    this.createTableSettings[tableId] = this.buildDefaultSetting(tableId);
  }

  private ensureEditSetting(tableId: string): void {
    if (this.editTableSettings[tableId]) return;
    this.editTableSettings[tableId] = this.buildDefaultSetting(tableId);
  }

  private buildSettingGroup(setting: FrequentClientTableSetting): FormGroup {
    return new FormGroup({
      tableId: new FormControl(setting.tableId, { nonNullable: true }),
      paymentStatus: new FormControl(setting.paymentStatus, { nonNullable: true }),
      amountDue: new FormControl(setting.amountDue, { nonNullable: true }),
      amountPaid: new FormControl(setting.amountPaid ?? 0, { nonNullable: true }),
      paymentDeadlineTime: new FormControl(setting.paymentDeadlineTime ?? this.defaultDeadlineTime, {
        nonNullable: true,
      }),
      paymentDeadlineTz: new FormControl(setting.paymentDeadlineTz ?? this.defaultDeadlineTz, {
        nonNullable: true,
      }),
    });
  }

  private findEditSettingIndex(tableId: string): number {
    const normalized = String(tableId ?? '').trim().toUpperCase();
    return this.editSettings.controls.findIndex(
      (group) => group.controls['tableId'].value === normalized
    );
  }

  editTableIdAt(index: number): string {
    return this.editSettings.at(index)?.controls['tableId'].value ?? '';
  }

  editStatusAt(index: number): PaymentStatus {
    return this.editSettings.at(index)?.controls['paymentStatus'].value ?? 'PENDING';
  }

  isEditCourtesy(index: number): boolean {
    return this.editStatusAt(index) === 'COURTESY';
  }

  isEditPendingOrPartial(index: number): boolean {
    const status = this.editStatusAt(index);
    return status === 'PENDING' || status === 'PARTIAL';
  }

  private buildDefaultSetting(tableId: string): FrequentClientTableSetting {
    const normalized = String(tableId ?? '').trim().toUpperCase();
    const amountDue = this.tablePriceById[normalized] ?? 0;
    return {
      tableId: normalized,
      paymentStatus: 'PENDING',
      amountDue,
      amountPaid: 0,
      paymentDeadlineTime: this.defaultDeadlineTime,
      paymentDeadlineTz: this.defaultDeadlineTz,
    };
  }

  private normalizeSetting(
    setting: FrequentClientTableSetting
  ): FrequentClientTableSetting {
    const tableId = String(setting.tableId ?? '').trim().toUpperCase();
    const amountDue = Number(setting.amountDue ?? this.tablePriceById[tableId] ?? 0);
    const base: FrequentClientTableSetting = {
      tableId,
      paymentStatus: (setting.paymentStatus ?? 'PENDING') as PaymentStatus,
      amountDue,
      amountPaid: setting.amountPaid ?? 0,
      paymentDeadlineTime: setting.paymentDeadlineTime ?? this.defaultDeadlineTime,
      paymentDeadlineTz: setting.paymentDeadlineTz ?? this.defaultDeadlineTz,
    };
    return this.applyRules(base);
  }

  private applyRules(setting: FrequentClientTableSetting): FrequentClientTableSetting {
    const next = { ...setting };
    if (next.paymentStatus === 'COURTESY') {
      next.amountDue = 0;
      next.amountPaid = 0;
      return next;
    }
    if (next.amountDue < 0 || Number.isNaN(next.amountDue)) {
      next.amountDue = 0;
    }
    if (next.paymentStatus === 'PAID') {
      next.amountPaid = next.amountDue;
      return next;
    }
    if (next.paymentStatus === 'PENDING') {
      next.amountPaid = 0;
      if (!next.paymentDeadlineTime) next.paymentDeadlineTime = this.defaultDeadlineTime;
      next.paymentDeadlineTz = this.defaultDeadlineTz;
      return next;
    }
    if (next.paymentStatus === 'PARTIAL') {
      const paid = Number(next.amountPaid ?? 0);
      next.amountPaid = Number.isFinite(paid) ? Math.max(0, paid) : 0;
      if (!next.paymentDeadlineTime) next.paymentDeadlineTime = this.defaultDeadlineTime;
      next.paymentDeadlineTz = this.defaultDeadlineTz;
      return next;
    }
    return next;
  }

  private serializeSettings(
    selected: Set<string>,
    settings: Record<string, FrequentClientTableSetting>
  ): FrequentClientTableSetting[] {
    return Array.from(selected)
      .map((tableId) => settings[tableId])
      .filter(Boolean)
      .map((setting) => ({
        tableId: setting.tableId,
        paymentStatus: setting.paymentStatus,
        amountDue: Number(setting.amountDue ?? 0),
        amountPaid:
          setting.paymentStatus === 'PAID'
            ? Number(setting.amountDue ?? 0)
            : setting.paymentStatus === 'COURTESY'
              ? 0
              : Number(setting.amountPaid ?? 0),
        paymentDeadlineTime:
          setting.paymentStatus === 'PENDING' || setting.paymentStatus === 'PARTIAL'
            ? setting.paymentDeadlineTime ?? this.defaultDeadlineTime
            : undefined,
        paymentDeadlineTz:
          setting.paymentStatus === 'PENDING' || setting.paymentStatus === 'PARTIAL'
            ? setting.paymentDeadlineTz ?? this.defaultDeadlineTz
            : undefined,
      }));
  }
}
