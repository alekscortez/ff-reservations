import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { useApiClient } from '@/lib/use-api-client';
import { useBodyScrollLock } from '@/lib/use-body-scroll-lock';
import type { ReservationItem } from '@ff/core';
import {
  formatPhoneForDisplay,
  inferPhoneCountryFromE164,
  normalizePhoneToE164,
} from '@ff/core';
import { useEventsList } from '@/lib/api/events';
import { useTablesForEvent, type TableForEvent } from '@/lib/api/tables';
import { useCreateHold, useHoldsList, useReleaseHold, type Hold } from '@/lib/api/holds';
import {
  useCreateCashAppLink,
  useCreateReservation,
  useCreateSquarePaymentLink,
  useSendCashAppLinkSms,
  useSendSquareLinkSms,
} from '@/lib/api/reservations';
import { usePackagesList } from '@/lib/api/packages';
import { useEventContext } from '@/lib/api/settings';
import {
  useCrmSearch,
  useRescheduleCredits,
  type CrmClient,
  type RescheduleCredit,
} from '@/lib/api/clients';
import { TableMap } from '@/components/table-map';

type PaymentMethodChoice = 'cash' | 'square' | 'cashapp';
type PaymentStatusChoice = 'PAID' | 'PARTIAL' | 'PENDING' | 'COURTESY';

interface CustomerForm {
  customerName: string;
  phone: string;
  phoneCountry: 'US' | 'MX';
  paymentMethod: PaymentMethodChoice;
  paymentStatus: PaymentStatusChoice;
  amountDue: number;
  depositAmount: number;
  paymentDeadlineDate: string;
  paymentDeadlineTime: string;
  packageId: string;
  receiptNumber: string;
}

function nextDayDateString(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Add `days` to a YYYY-MM-DD date string using UTC arithmetic so DST shifts
// don't bump the date by ±1 day. Returns the input unchanged on parse error.
function addDaysToDateString(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Build a YYYY-MM-DDTHH:mm:ss string representing "now" in the given IANA tz.
// Used for string-comparison against staff-typed deadlines. Falls back to
// Date#toISOString slice on tz errors.
function nowInTimeZoneLocalIso(tz: string, when: Date = new Date()): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(when).map((p) => [p.type, p.value])
    );
    const hh = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}`;
  } catch {
    return when.toISOString().slice(0, 19);
  }
}
const HOLD_STORAGE_KEY = 'ff_new_res_active_hold_v1';
const FILTERS_STORAGE_KEY = 'ff_new_res_filters_v1';

type TableStatusFilter =
  | 'ALL'
  | 'AVAILABLE'
  | 'HOLD'
  | 'PENDING_PAYMENT'
  | 'RESERVED'
  | 'DISABLED';

const STATUS_FILTER_VALUES: TableStatusFilter[] = [
  'ALL',
  'AVAILABLE',
  'HOLD',
  'PENDING_PAYMENT',
  'RESERVED',
  'DISABLED',
];

interface TableFilters {
  search: string;
  status: TableStatusFilter;
  sections: string[]; // empty = all
}

const DEFAULT_FILTERS: TableFilters = {
  search: '',
  status: 'ALL',
  sections: [],
};

interface PersistedHoldSession {
  hold: Hold;
  eventDate: string;
  form: CustomerForm;
  allowCustomDeposit: boolean;
  paymentDeadlineEnabled: boolean;
  creditEnabled: boolean;
  selectedCreditId: string | null;
  savedAt: number;
}

export function ReservationNew() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [eventDate, setEventDate] = useState<string>('');
  const [hold, setHold] = useState<Hold | null>(null);
  // Track whether we own the hold or are merely viewing one created elsewhere
  // (e.g. surfaced via listLocks during a session restore). Only release-prompt
  // on our own holds — Angular parity.
  const [holdCreatedByMe, setHoldCreatedByMe] = useState(false);
  // Two-step hold pattern: clicking a table sets selectedTableId; the actual
  // POST /holds fires from the bottom CTA bar's "Hold & Reserve" button. Match
  // Angular's deliberate confirm step instead of the React port's instant hold.
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const { data: events, isLoading: eventsLoading } = useEventsList();
  const { data: ctx } = useEventContext();
  const operatingTz = ctx?.operatingTz || ctx?.settings?.operatingTz || 'America/Chicago';
  const defaultDeadlineHour =
    Number.isFinite(ctx?.settings?.defaultPaymentDeadlineHour)
      ? Number(ctx?.settings?.defaultPaymentDeadlineHour)
      : 0;
  const defaultDeadlineMinute =
    Number.isFinite(ctx?.settings?.defaultPaymentDeadlineMinute)
      ? Number(ctx?.settings?.defaultPaymentDeadlineMinute)
      : 0;
  const sectionMapColors = ctx?.settings?.sectionMapColors;
  const tablePollingSeconds = (() => {
    const raw = ctx?.settings?.tableAvailabilityPollingSeconds;
    if (raw === undefined || raw === null) return 10;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 10;
  })();
  // Hoisted forward-ref so the polling decision can pause when the form
  // modal is open. The actual modal-open state is computed further below
  // (depends on `heldTable` which itself depends on `tablesData`); we wire
  // it through a state ref so the hook call stays at the top.
  const [pollingPaused, setPollingPaused] = useState(false);
  const { data: tablesData, isLoading: tablesLoading } = useTablesForEvent(
    eventDate || null,
    { pollingSeconds: pollingPaused ? null : tablePollingSeconds }
  );
  const { data: packages } = usePackagesList();
  const createHold = useCreateHold();
  const releaseHold = useReleaseHold(eventDate);
  const createReservation = useCreateReservation();

  const sortedEvents = useMemo(() => {
    if (!events) return [];
    return [...events]
      .filter((e) => e.status === 'ACTIVE')
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  }, [events]);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const inAWeekStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }, []);
  const pastEvents = useMemo(() => {
    if (!events) return [];
    return [...events]
      .filter((e) => e.eventDate < todayStr)
      .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  }, [events, todayStr]);
  const [pastModalOpen, setPastModalOpen] = useState(false);
  const [pastSearch, setPastSearch] = useState('');
  const filteredPast = useMemo(() => {
    const q = pastSearch.trim().toLowerCase();
    if (!q) return pastEvents;
    return pastEvents.filter(
      (e) =>
        e.eventName.toLowerCase().includes(q) ||
        e.eventDate.includes(q)
    );
  }, [pastEvents, pastSearch]);

  useEffect(() => {
    if (eventDate || sortedEvents.length === 0) return;
    // Deep-link: ?eventDate or ?date (Angular original) take priority over
    // the auto-pick if either matches an active event. Reading both keeps
    // bookmarks from the legacy app working.
    const requested =
      (searchParams.get('eventDate') ?? '').trim() ||
      (searchParams.get('date') ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
      const match = sortedEvents.find((e) => e.eventDate === requested);
      if (match) {
        setEventDate(match.eventDate);
        return;
      }
    }
    // Prefer the operating-day's current event (or next active) from context;
    // falls back to "next ≥ browser-today" if context isn't loaded yet.
    const ctxPick = ctx?.event?.eventDate || ctx?.nextEvent?.eventDate;
    if (ctxPick) {
      setEventDate(ctxPick);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const next = sortedEvents.find((e) => e.eventDate >= today) ?? sortedEvents[0];
    setEventDate(next.eventDate);
  }, [eventDate, sortedEvents, searchParams, ctx]);

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const selectedEvent = useMemo(
    () =>
      sortedEvents.find((e) => e.eventDate === eventDate) ??
      (events ?? []).find((e) => e.eventDate === eventDate) ??
      null,
    [sortedEvents, events, eventDate]
  );

  const tablesArray = tablesData?.tables ?? [];

  const [tableView, setTableView] = useState<'map' | 'list'>('map');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<TableFilters>(() => {
    try {
      const raw =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(FILTERS_STORAGE_KEY)
          : null;
      if (!raw) return DEFAULT_FILTERS;
      const parsed = JSON.parse(raw) as Partial<TableFilters & { showAvailable?: boolean; showUnavailable?: boolean }>;
      // Migrate legacy showAvailable/showUnavailable booleans → status enum.
      let status: TableStatusFilter = 'ALL';
      if (typeof parsed.status === 'string' && STATUS_FILTER_VALUES.includes(parsed.status as TableStatusFilter)) {
        status = parsed.status as TableStatusFilter;
      } else if (parsed.showAvailable === true && parsed.showUnavailable === false) {
        status = 'AVAILABLE';
      }
      return {
        search: typeof parsed.search === 'string' ? parsed.search : '',
        status,
        sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      };
    } catch {
      return DEFAULT_FILTERS;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
    } catch {
      /* ignore */
    }
  }, [filters]);
  const activeFiltersCount =
    (filters.search.trim().length > 0 ? 1 : 0) +
    (filters.status !== 'ALL' ? 1 : 0) +
    (filters.sections.length > 0 ? 1 : 0);
  const filtersActive = activeFiltersCount > 0;
  const filteredTables = useMemo(() => {
    const q = filters.search.trim().toUpperCase();
    return tablesArray.filter((tb) => {
      if (filters.status !== 'ALL' && tb.status !== filters.status) return false;
      if (filters.sections.length > 0 && !filters.sections.includes(tb.section)) {
        return false;
      }
      if (q && !tb.id.toUpperCase().includes(q)) return false;
      return true;
    });
  }, [tablesArray, filters]);
  const sectionStats = useMemo(() => {
    const map = new Map<string, { total: number; available: number }>();
    for (const tb of tablesArray) {
      const cur = map.get(tb.section) ?? { total: 0, available: 0 };
      cur.total += 1;
      if (tb.status === 'AVAILABLE') cur.available += 1;
      map.set(tb.section, cur);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tablesArray]);

  const availableSectionKeys = useMemo(
    () => sectionStats.map(([s]) => s),
    [sectionStats]
  );

  const heldTable = useMemo(() => {
    if (!hold || !tablesData?.tables) return null;
    return tablesData.tables.find((tb) => tb.id === hold.tableId) ?? null;
  }, [hold, tablesData?.tables]);

  const selectedTable = useMemo(() => {
    if (!selectedTableId) return null;
    return tablesArray.find((tb) => tb.id === selectedTableId) ?? null;
  }, [tablesArray, selectedTableId]);

  const remainingSec = hold?.expiresAt ? hold.expiresAt - nowSec : 0;
  const expired = hold?.expiresAt ? remainingSec <= 0 : false;

  const minDeposit = selectedEvent?.minDeposit ?? 0;
  const tablePrice = heldTable?.price ?? 0;

  const [allowCustomDeposit, setAllowCustomDeposit] = useState(false);
  const [paymentDeadlineEnabled, setPaymentDeadlineEnabled] = useState(false);

  const { register, handleSubmit, watch, setValue, reset, getValues } = useForm<CustomerForm>({
    defaultValues: {
      customerName: '',
      phone: '',
      phoneCountry: 'MX',
      paymentMethod: 'square',
      paymentStatus: 'PENDING',
      amountDue: 0,
      depositAmount: 0,
      paymentDeadlineDate: nextDayDateString(),
      paymentDeadlineTime: '00:00',
      packageId: '',
      receiptNumber: '',
    },
  });

  const watchedMethod = watch('paymentMethod');
  const watchedStatus = watch('paymentStatus');
  const watchedAmountDue = Number(watch('amountDue')) || 0;
  const watchedDeposit = Number(watch('depositAmount')) || 0;
  const isCash = watchedMethod === 'cash';
  const isDigital = watchedMethod === 'square' || watchedMethod === 'cashapp';

  // When a table gets held, prefill amountDue with table price — but only if
  // it's still at the default 0. Skipping the prefill when a value is already
  // present avoids clobbering a restored hold session or staff-typed override.
  useEffect(() => {
    if (heldTable && tablePrice > 0 && (Number(getValues('amountDue')) || 0) <= 0) {
      setValue('amountDue', tablePrice);
    }
  }, [heldTable, tablePrice, setValue, getValues]);

  // Apply context-driven deadline defaults once on hold creation. We only
  // touch the field if the user hasn't typed a non-default value (the
  // restored-session check is implicit: the date/time fields will be set by
  // the restore effect before this runs).
  const [deadlineDefaultsApplied, setDeadlineDefaultsApplied] = useState(false);
  useEffect(() => {
    if (!hold || deadlineDefaultsApplied) return;
    // Override the literal defaults the form was constructed with. Date
    // defaults to event-date + 1 (matches Angular: a Saturday event's
    // deadline defaults to Sunday, not "tomorrow from staff perspective").
    // Falls back to browser-tomorrow when no event is loaded yet.
    const fallbackTomorrow = nextDayDateString();
    if (getValues('paymentDeadlineDate') === fallbackTomorrow) {
      const eventBased = eventDate ? addDaysToDateString(eventDate, 1) : fallbackTomorrow;
      if (eventBased !== fallbackTomorrow) {
        setValue('paymentDeadlineDate', eventBased);
      }
    }
    if (
      ctx &&
      getValues('paymentDeadlineTime') === '00:00' &&
      (defaultDeadlineHour !== 0 || defaultDeadlineMinute !== 0)
    ) {
      setValue(
        'paymentDeadlineTime',
        `${pad2(defaultDeadlineHour)}:${pad2(defaultDeadlineMinute)}`
      );
    }
    setDeadlineDefaultsApplied(true);
  }, [hold, ctx, deadlineDefaultsApplied, defaultDeadlineHour, defaultDeadlineMinute, eventDate, getValues, setValue]);
  useEffect(() => {
    if (!hold) setDeadlineDefaultsApplied(false);
  }, [hold]);

  // Digital payments are always PENDING and need a deadline.
  useEffect(() => {
    if (isDigital) {
      setValue('paymentStatus', 'PENDING');
      setPaymentDeadlineEnabled(true);
    }
  }, [isDigital, setValue]);

  // Auto-suggest deposit based on cash payment status (unless user unlocked).
  useEffect(() => {
    if (allowCustomDeposit) return;
    if (isCash) {
      if (watchedStatus === 'PAID') setValue('depositAmount', watchedAmountDue);
      else if (watchedStatus === 'PARTIAL') {
        // halfway between min and full as a sensible default
        const half = Math.max(minDeposit, Math.round(watchedAmountDue / 2));
        setValue('depositAmount', half);
      } else if (watchedStatus === 'PENDING') setValue('depositAmount', 0);
      else if (watchedStatus === 'COURTESY') setValue('depositAmount', 0);
    } else if (isDigital) {
      setValue('depositAmount', 0);
    }
  }, [allowCustomDeposit, isCash, isDigital, watchedStatus, watchedAmountDue, minDeposit, setValue]);

  // Cash status determines whether a deadline is required (PARTIAL/PENDING).
  const cashRequiresDeadline =
    isCash && (watchedStatus === 'PARTIAL' || watchedStatus === 'PENDING');
  const deadlineRequired = isDigital || cashRequiresDeadline;

  useEffect(() => {
    if (deadlineRequired) setPaymentDeadlineEnabled(true);
  }, [deadlineRequired]);

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  // Step 1 of two-step hold: just toggles selection, no server call. Clicking
  // the same table again clears the selection.
  function handleTableSelect(table: TableForEvent) {
    if (table.status !== 'AVAILABLE') return;
    setSelectedTableId((cur) => (cur === table.id ? null : table.id));
  }

  // Step 2 of two-step hold: the bottom CTA "Hold & Reserve" calls this with
  // the currently-selected table.
  function confirmHoldSelected() {
    const table = tablesArray.find((tb) => tb.id === selectedTableId);
    if (!table || table.status !== 'AVAILABLE') return;
    // Forward any pre-typed contact info so the lock row carries it (Angular
    // parity — staff who already typed name/phone pre-hold). Phone gets
    // normalized to E.164 if possible; otherwise we send what was typed.
    const rawName = (getValues('customerName') ?? '').trim();
    const rawPhone = (getValues('phone') ?? '').trim();
    const country = (getValues('phoneCountry') ?? 'MX') as 'US' | 'MX';
    const normalizedPhone = rawPhone ? normalizePhoneToE164(rawPhone, country) || rawPhone : '';
    createHold.mutate(
      {
        eventDate,
        tableId: table.id,
        customerName: rawName || undefined,
        phone: normalizedPhone || undefined,
        phoneCountry: country,
      },
      {
        onSuccess: (created) => {
          setHold(created);
          setHoldCreatedByMe(true);
          setSelectedTableId(null);
        },
      }
    );
  }

  // Clear selection when the event changes or the table is no longer
  // available (e.g. someone else held it during polling).
  useEffect(() => {
    if (!selectedTableId) return;
    const t = tablesArray.find((tb) => tb.id === selectedTableId);
    if (!t || t.status !== 'AVAILABLE') setSelectedTableId(null);
  }, [tablesArray, selectedTableId]);
  useEffect(() => {
    setSelectedTableId(null);
  }, [eventDate]);

  type ReleaseIntent =
    | { kind: 'release' }
    | { kind: 'switchEvent'; nextEventDate: string };
  const [releaseIntent, setReleaseIntent] = useState<ReleaseIntent | null>(null);

  function handleReleaseHold() {
    if (!hold) return;
    // Only prompt for release if WE created the hold. A foreign hold (e.g.
    // surfaced via listLocks restoration) just closes the modal — it isn't
    // ours to release.
    if (!holdCreatedByMe) {
      setHold(null);
      return;
    }
    setReleaseIntent({ kind: 'release' });
  }

  function confirmReleaseIntent() {
    if (!hold || !releaseIntent) {
      setReleaseIntent(null);
      return;
    }
    const intent = releaseIntent;
    releaseHold.mutate(hold.tableId, {
      onSuccess: () => {
        setHold(null);
        setHoldCreatedByMe(false);
        if (intent.kind === 'switchEvent') setEventDate(intent.nextEventDate);
      },
    });
    setReleaseIntent(null);
  }

  const [createdReservation, setCreatedReservation] = useState<ReservationItem | null>(null);

  // Restore an active hold session from localStorage on first mount. Survives
  // page reloads / accidental tab close — staff don't lose their typed customer
  // info if a refresh happens mid-flow. Discard if the hold has already
  // expired (server-side). Done before any other form effect so the typed
  // values aren't clobbered by the prefill-amountDue effect.
  const [restoredOnce, setRestoredOnce] = useState(false);
  useEffect(() => {
    if (restoredOnce) return;
    try {
      const raw =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(HOLD_STORAGE_KEY)
          : null;
      if (!raw) {
        setRestoredOnce(true);
        return;
      }
      const data = JSON.parse(raw) as Partial<PersistedHoldSession>;
      const nowS = Math.floor(Date.now() / 1000);
      const exp = Number(data?.hold?.expiresAt ?? 0);
      if (!data?.hold || !data.eventDate || exp <= nowS) {
        window.localStorage.removeItem(HOLD_STORAGE_KEY);
        setRestoredOnce(true);
        return;
      }
      setHold(data.hold as Hold);
      // Restored hold is from a prior session of this same user → still ours.
      setHoldCreatedByMe(true);
      setEventDate(data.eventDate);
      if (data.form) reset(data.form as CustomerForm);
      setAllowCustomDeposit(Boolean(data.allowCustomDeposit));
      setPaymentDeadlineEnabled(Boolean(data.paymentDeadlineEnabled));
    } catch {
      try {
        window.localStorage.removeItem(HOLD_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
    setRestoredOnce(true);
  }, [restoredOnce, reset]);

  // After restoring from localStorage, verify the hold still exists on the
  // server with a matching holdId. The TTL on the lock is 10–15 min so a
  // refresh after a long pause may surface a session whose row has been
  // garbage-collected; trusting localStorage alone would let staff fill out
  // the form and POST /reservations only to hit a 409.
  const [holdVerifiedAt, setHoldVerifiedAt] = useState<number | null>(null);
  const [holdValidationError, setHoldValidationError] = useState<string | null>(null);
  const holdsList = useHoldsList(hold ? eventDate : null);
  useEffect(() => {
    if (!hold || !holdsList.data) return;
    if (holdVerifiedAt) return;
    const stillThere = holdsList.data.find(
      (lock) =>
        lock.tableId === hold.tableId &&
        (lock.holdId === hold.holdId || lock.lockType === 'RESERVED')
    );
    if (!stillThere) {
      setHold(null);
      setHoldCreatedByMe(false);
      setHoldValidationError(t('reservationNew.holdValidation.lost'));
      try {
        window.localStorage.removeItem(HOLD_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
    setHoldVerifiedAt(Math.floor(Date.now() / 1000));
  }, [hold, holdsList.data, holdVerifiedAt, t]);
  // Re-validate on every fresh hold (clear the verifiedAt mark when hold changes).
  useEffect(() => {
    if (!hold) {
      setHoldVerifiedAt(null);
      return;
    }
    setHoldVerifiedAt(null);
  }, [hold?.holdId]);

  const watchedPhone = watch('phone');
  const watchedPhoneCountry = watch('phoneCountry');
  const [debouncedPhone, setDebouncedPhone] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedPhone(watchedPhone.trim()), 350);
    return () => clearTimeout(id);
  }, [watchedPhone]);
  const crmSearch = useCrmSearch(debouncedPhone);
  const crmMatchesRaw = crmSearch.data ?? [];
  const enteredDigits = debouncedPhone.replace(/\D/g, '');
  const showCrmPanel = enteredDigits.length >= 3 && !createdReservation;
  // Match Angular: only show "no match" once the user has typed a full 10-digit
  // number — earlier than that, "no match" feels punitive.
  const noCrmMatch =
    showCrmPanel &&
    !crmSearch.isLoading &&
    crmMatchesRaw.length === 0 &&
    enteredDigits.length >= 10;
  // Auto-fill on exact phone match at 10+ digits. Once we recognize the
  // customer, hide the dropdown so the form looks clean.
  const [exactMatchPhone, setExactMatchPhone] = useState<string | null>(null);
  useEffect(() => {
    if (enteredDigits.length < 10 || crmMatchesRaw.length === 0) {
      setExactMatchPhone(null);
      return;
    }
    const exact = crmMatchesRaw.find((m) => {
      const stored = String(m.phone ?? '').replace(/\D/g, '');
      if (!stored) return false;
      if (stored === enteredDigits) return true;
      if (enteredDigits.length === 10) {
        return (
          stored === `1${enteredDigits}` ||
          stored === `52${enteredDigits}` ||
          stored === `521${enteredDigits}`
        );
      }
      return false;
    });
    if (!exact) {
      setExactMatchPhone(null);
      return;
    }
    setExactMatchPhone(String(exact.phone ?? '').replace(/\D/g, ''));
    if (exact.name) setValue('customerName', exact.name, { shouldDirty: true });
    if (exact.phone) setValue('phone', exact.phone, { shouldDirty: true });
    const inferredCountry = inferPhoneCountryFromE164(exact.phone);
    const country =
      exact.phoneCountry === 'US' || exact.phoneCountry === 'MX'
        ? exact.phoneCountry
        : inferredCountry;
    if (country) setValue('phoneCountry', country, { shouldDirty: true });
  }, [enteredDigits, crmMatchesRaw, setValue]);
  // Hide the matches list when a row is auto-applied.
  const crmMatches = exactMatchPhone ? [] : crmMatchesRaw;

  // Credits lookup: only fires once we have a CRM-confirmed phone (i.e. at least
  // one match in the search). Backend keys credits on (phone, phoneCountry).
  const crmConfirmed = crmMatches.length > 0;
  const creditsQuery = useRescheduleCredits(
    crmConfirmed ? debouncedPhone : null,
    watchedPhoneCountry
  );
  const availableCredits = useMemo<RescheduleCredit[]>(() => {
    return (creditsQuery.data ?? []).filter((c) => {
      if (c.status !== 'AVAILABLE') return false;
      const remaining = Number(c.amount ?? 0) - Number(c.amountUsed ?? 0);
      return remaining > 0.005;
    });
  }, [creditsQuery.data]);
  const [selectedCreditId, setSelectedCreditId] = useState<string | null>(null);
  // Auto-select the largest credit when the panel first appears.
  useEffect(() => {
    if (availableCredits.length === 0) {
      if (selectedCreditId) setSelectedCreditId(null);
      return;
    }
    if (selectedCreditId && availableCredits.some((c) => c.creditId === selectedCreditId)) {
      return;
    }
    const sorted = [...availableCredits].sort((a, b) => {
      const ar = Number(a.amount ?? 0) - Number(a.amountUsed ?? 0);
      const br = Number(b.amount ?? 0) - Number(b.amountUsed ?? 0);
      return br - ar;
    });
    setSelectedCreditId(sorted[0].creditId);
  }, [availableCredits, selectedCreditId]);
  const selectedCredit = useMemo(
    () => availableCredits.find((c) => c.creditId === selectedCreditId) ?? null,
    [availableCredits, selectedCreditId]
  );
  const [creditEnabled, setCreditEnabled] = useState(false);
  // If credits disappear (phone change), turn off the toggle.
  useEffect(() => {
    if (availableCredits.length === 0 && creditEnabled) setCreditEnabled(false);
  }, [availableCredits.length, creditEnabled]);
  const creditRemainingOnSelected = selectedCredit
    ? Math.max(
        0,
        Number(selectedCredit.amount ?? 0) - Number(selectedCredit.amountUsed ?? 0)
      )
    : 0;
  const creditApplied = creditEnabled && selectedCredit
    ? Math.min(creditRemainingOnSelected, watchedAmountDue || 0)
    : 0;
  const creditRemainderDue = creditEnabled
    ? Math.max(0, (watchedAmountDue || 0) - creditApplied)
    : watchedAmountDue || 0;
  // When credit is applied with a remainder, the staff still owes us a
  // payment deadline for that balance — auto-enable the deadline panel so
  // they can't accidentally submit without one.
  useEffect(() => {
    if (creditEnabled && creditRemainderDue > 0.005) {
      setPaymentDeadlineEnabled(true);
    }
  }, [creditEnabled, creditRemainderDue]);
  const apiClient = useApiClient();
  const [creditApplyError, setCreditApplyError] = useState<string | null>(null);

  // Lock background scroll while any modal in this view is open. Stacked
  // modals (e.g. past-events open over the hold form) are ref-counted so the
  // body unlocks only when all close.
  const formModalOpen = Boolean(createdReservation) || Boolean(hold && heldTable);
  useBodyScrollLock(formModalOpen);
  useBodyScrollLock(pastModalOpen);
  useBodyScrollLock(Boolean(releaseIntent));
  // Pause the tables refetchInterval while the booking modal is open so the
  // SVG floor plan doesn't reshuffle out from under the staff mid-form.
  useEffect(() => {
    setPollingPaused(formModalOpen);
  }, [formModalOpen]);

  // Auto-clear the hold (and persisted session) when the timer reaches zero.
  // The modal already shows the EXPIRED banner via `expired`; this just
  // transitions the user back to the table picker after a short grace so they
  // can read it before the modal disappears.
  useEffect(() => {
    if (!hold || !expired) return;
    const id = setTimeout(() => {
      setHold(null);
      setHoldCreatedByMe(false);
      try {
        window.localStorage.removeItem(HOLD_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }, 4000);
    return () => clearTimeout(id);
  }, [hold, expired]);

  // Mobile keyboard inset: keep the sticky CTA above the on-screen keyboard.
  // visualViewport.height shrinks while the keyboard is up; the diff is the
  // keyboard height. Stash it as a CSS var on the modal root.
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    const vv =
      typeof window !== 'undefined' ? window.visualViewport ?? null : null;
    if (!vv) return;
    const update = () => {
      const diff = window.innerHeight - vv.height - vv.offsetTop;
      setKbInset(diff > 50 ? diff : 0);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // Persist the active hold session whenever any captured field changes. The
  // load effect above will restore it on next mount if the hold hasn't expired.
  useEffect(() => {
    if (!restoredOnce) return;
    const clear = () => {
      try {
        window.localStorage.removeItem(HOLD_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    };
    if (!hold || expired || createdReservation) {
      clear();
      return;
    }
    const save = () => {
      const data: PersistedHoldSession = {
        hold,
        eventDate,
        form: getValues(),
        allowCustomDeposit,
        paymentDeadlineEnabled,
        creditEnabled,
        selectedCreditId,
        savedAt: Math.floor(Date.now() / 1000),
      };
      try {
        window.localStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(data));
      } catch {
        /* quota / disabled — ignore */
      }
    };
    save();
    const sub = watch(() => save());
    return () => sub.unsubscribe();
  }, [
    restoredOnce,
    hold,
    expired,
    createdReservation,
    eventDate,
    allowCustomDeposit,
    paymentDeadlineEnabled,
    creditEnabled,
    selectedCreditId,
    getValues,
    watch,
  ]);

  function applyCrmMatch(client: CrmClient) {
    if (client.name) setValue('customerName', client.name, { shouldDirty: true });
    if (client.phone) setValue('phone', client.phone, { shouldDirty: true });
    // Prefer the explicit phoneCountry the CRM stores; fall back to inferring
    // from the E.164 phone (covers legacy rows with no phoneCountry field).
    const explicit =
      client.phoneCountry === 'US' || client.phoneCountry === 'MX'
        ? client.phoneCountry
        : null;
    const inferred = inferPhoneCountryFromE164(client.phone);
    const country = explicit ?? inferred;
    if (country) {
      setValue('phoneCountry', country, { shouldDirty: true });
    }
  }

  const [deadlineError, setDeadlineError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const onInvalidSubmit = (errors: Record<string, unknown>) => {
    if (errors.customerName) setFormError(t('reservationNew.formError.customerName'));
    else if (errors.phone) setFormError(t('reservationNew.formError.phone'));
    else if (errors.amountDue) setFormError(t('reservationNew.formError.amountDue'));
    else if (errors.depositAmount) setFormError(t('reservationNew.formError.depositAmount'));
    else if (errors.paymentMethod) setFormError(t('reservationNew.formError.paymentMethod'));
    else setFormError(t('reservationNew.formError.review'));
  };
  const onSubmit = handleSubmit(async (form) => {
    if (!hold) return;
    setCreditApplyError(null);
    setDeadlineError(null);
    setPhoneError(null);
    setFormError(null);
    // Pre-validate the phone is a valid US/MX E.164 — backend validates too
    // but surfacing inline saves a network round-trip and matches the
    // Angular original's UX.
    const normalizedPhone = normalizePhoneToE164(form.phone, form.phoneCountry);
    if (!normalizedPhone) {
      setPhoneError(t('reservationNew.phoneValidation.invalid'));
      return;
    }
    // When applying a credit, the reservation is created as PENDING with no
    // deposit; the credit lands as a separate payment immediately after via
    // PUT /reservations/{id}/payment with method=credit. The remainder (if any)
    // is collected through the post-create Square link panel.
    const useCredit = creditEnabled && creditApplied > 0;
    const amountDue = Number(form.amountDue) || 0;
    const wantsDeadline = useCredit
      ? amountDue - creditApplied > 0.005
      : paymentDeadlineEnabled || isDigital || cashRequiresDeadline;
    const paymentDeadlineAt = wantsDeadline
      ? `${form.paymentDeadlineDate}T${form.paymentDeadlineTime}:00`
      : undefined;
    // Pre-validate the deadline is in the future relative to the operating
    // timezone. Backend will reject otherwise but we surface it inline so
    // staff don't have to wait for the network round-trip.
    if (paymentDeadlineAt) {
      const nowIso = nowInTimeZoneLocalIso(operatingTz);
      if (paymentDeadlineAt <= nowIso) {
        setDeadlineError(
          t('reservationNew.deadlineValidation.past', { tz: operatingTz })
        );
        return;
      }
    }
    const status: PaymentStatusChoice = useCredit
      ? 'PENDING'
      : isDigital
        ? 'PENDING'
        : form.paymentStatus;
    const created = await createReservation.mutateAsync({
      eventDate,
      tableId: hold.tableId,
      holdId: hold.holdId ?? '',
      customerName: form.customerName.trim(),
      phone: normalizedPhone,
      phoneCountry: form.phoneCountry,
      paymentMethod: form.paymentMethod,
      paymentStatus: status,
      amountDue,
      depositAmount: useCredit ? 0 : Number(form.depositAmount) || 0,
      packageId: form.packageId || undefined,
      receiptNumber: form.receiptNumber.trim() || undefined,
      paymentDeadlineAt,
      paymentDeadlineTz: wantsDeadline ? operatingTz : undefined,
    });
    if (useCredit && selectedCredit) {
      try {
        const res = await apiClient.put<{ item: ReservationItem }>(
          `/reservations/${created.reservationId}/payment`,
          {
            eventDate,
            amount: creditApplied,
            method: 'credit',
            creditId: selectedCredit.creditId,
          }
        );
        setCreatedReservation(res.item ?? created);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? `${err.status}: ${err.message}`
            : (err as Error)?.message ?? 'Failed to apply credit';
        setCreditApplyError(msg);
        setCreatedReservation(created);
      }
    } else {
      setCreatedReservation(created);
    }
    setHold(null);
    setHoldCreatedByMe(false);
  }, onInvalidSubmit);

  const submitError =
    createReservation.error instanceof ApiError
      ? `${createReservation.error.status}: ${createReservation.error.message}`
      : null;
  const holdError =
    createHold.error instanceof ApiError
      ? `${createHold.error.status}: ${createHold.error.message}`
      : null;

  const depositValid = creditEnabled
    ? true
    : isCash && watchedStatus === 'COURTESY'
      ? true
      : isCash && watchedStatus === 'PAID'
        ? Math.abs(watchedDeposit - watchedAmountDue) < 0.01
        : isCash
          ? watchedDeposit >= minDeposit
          : true;

  return (
    <div className="p-6 sm:p-8">
      <div className="mx-auto max-w-4xl space-y-5 lg:max-w-6xl">
        <div className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {t('reservationNew.title')}
          </h1>
          <Link
            to="/staff/reservations"
            className="text-sm text-muted-foreground hover:text-brand-900"
          >
            ← {t('reservations.listTitle')}
          </Link>
        </div>

        <section className="rounded-lg border border-border bg-background px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-brand-900">
              <span className="text-brand-700">{t('reservationNew.eventLabel')}: </span>
              <span className="font-semibold">
                {selectedEvent
                  ? `${selectedEvent.eventName} (${selectedEvent.eventDate})`
                  : eventsLoading
                    ? t('common.loading')
                    : t('events.empty')}
              </span>
              {selectedEvent && Number(selectedEvent.minDeposit ?? 0) > 0 && (
                <span className="ml-3 text-xs text-muted-foreground">
                  {t('reservationNew.minDeposit')}:{' '}
                  {moneyFormatter.format(selectedEvent.minDeposit)}
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={() => setPastModalOpen(true)}
              disabled={Boolean(hold)}
              className="rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-brand-900 hover:bg-muted disabled:opacity-50"
            >
              {t('reservationNew.changeEvent')}
            </button>
          </div>
        </section>

        {eventDate ? (
          <section className="rounded-lg border border-border bg-background p-4 pb-24 lg:pb-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-3">
                <h2 className="text-sm font-semibold text-brand-900">
                  {t('reservationNew.pickTable')}
                </h2>
                {sectionStats.length > 0 && (
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {sectionStats
                      .map(([s, c]) => `${s}: ${c.available}/${c.total}`)
                      .join(' · ')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  value={filters.search}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, search: e.target.value }))
                  }
                  placeholder={t('reservationNew.filters.searchPlaceholder')}
                  aria-label={t('reservationNew.filters.search')}
                  className="w-32 rounded-md border border-border bg-background px-2 py-1 text-xs uppercase sm:w-40"
                />
                <div
                  role="tablist"
                  aria-label={t('reservationNew.view.label')}
                  className="inline-flex rounded-md border border-border bg-background p-0.5 text-xs md:hidden"
                >
                  {(['map', 'list'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={tableView === v}
                      onClick={() => setTableView(v)}
                      className={`rounded px-3 py-1 font-medium transition ${
                        tableView === v
                          ? 'bg-primary text-primary-foreground'
                          : 'text-brand-900 hover:bg-muted'
                      }`}
                    >
                      {t(`reservationNew.view.${v}`)}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setFiltersOpen((v) => !v)}
                  aria-label={t('reservationNew.filters.button')}
                  className={`relative rounded-md border px-3 py-1 text-xs font-medium ${
                    filtersActive
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-brand-900 hover:bg-muted'
                  }`}
                >
                  {t('reservationNew.filters.button')}
                  {filtersActive && (
                    <span className="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground">
                      {activeFiltersCount}
                    </span>
                  )}
                </button>
              </div>
            </div>
            {filtersOpen && (
              <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-brand-700">
                      {t('reservationNew.filters.status')}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {STATUS_FILTER_VALUES.map((s) => {
                        const on = filters.status === s;
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setFilters((f) => ({ ...f, status: s }))}
                            className={`rounded-md border px-2 py-0.5 text-xs ${
                              on
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-background text-brand-900 hover:bg-muted'
                            }`}
                          >
                            {t(`reservationNew.filters.statusValues.${s}`)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-brand-700">
                      {t('reservationNew.filters.sections')}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {availableSectionKeys.map((s) => {
                        const on = filters.sections.includes(s);
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() =>
                              setFilters((f) => ({
                                ...f,
                                sections: on
                                  ? f.sections.filter((x) => x !== s)
                                  : [...f.sections, s],
                              }))
                            }
                            className={`rounded-md border px-2 py-0.5 text-xs ${
                              on
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-background text-brand-900 hover:bg-muted'
                            }`}
                          >
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                {filtersActive && (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setFilters(DEFAULT_FILTERS)}
                      className="text-xs text-muted-foreground hover:text-brand-900"
                    >
                      {t('reservationNew.filters.reset')}
                    </button>
                  </div>
                )}
              </div>
            )}
            {holdError && <p className="mt-2 text-xs text-destructive">{holdError}</p>}
            {holdValidationError && !hold && (
              <p
                className="mt-2 rounded-md border border-destructive/40 bg-danger-100/40 p-2 text-xs text-destructive"
                role="alert"
              >
                {holdValidationError}
              </p>
            )}
            {tablesLoading ? (
              <p className="mt-3 text-muted-foreground">{t('common.loading')}</p>
            ) : tablesArray.length === 0 ? (
              <p className="mt-3 text-muted-foreground">{t('events.empty')}</p>
            ) : (
              <>
                {/* Phone: single view driven by the toggle pill. */}
                <div className="mt-3 md:hidden">
                  {tableView === 'map' ? (
                    <TableMap
                      tables={tablesArray}
                      interactive={!createHold.isPending}
                      onSelect={handleTableSelect}
                      selectedTableId={selectedTableId ?? hold?.tableId ?? null}
                      sectionColors={sectionMapColors}
                    />
                  ) : (
                    <TableListView
                      tables={filteredTables}
                      disabled={createHold.isPending}
                      onSelect={handleTableSelect}
                      selectedTableId={selectedTableId ?? hold?.tableId ?? null}
                      sectionColors={sectionMapColors}
                    />
                  )}
                </div>
                {/* Tablet+: map left, scrollable list right (always split). */}
                <div className="mt-3 hidden gap-4 md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                  <TableMap
                    tables={tablesArray}
                    interactive={!createHold.isPending}
                    onSelect={handleTableSelect}
                    selectedTableId={selectedTableId ?? hold?.tableId ?? null}
                    sectionColors={sectionMapColors}
                  />
                  <div className="flex flex-col">
                    <div className="mb-2 flex items-baseline justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
                      <span>{t('reservationNew.list.heading')}</span>
                      <span>
                        {t('reservationNew.list.results', { count: filteredTables.length })}
                      </span>
                    </div>
                    <div className="max-h-[68vh] overflow-y-auto rounded-md border border-border bg-background p-2">
                      <TableListView
                        tables={filteredTables}
                        disabled={createHold.isPending}
                        onSelect={handleTableSelect}
                        selectedTableId={selectedTableId ?? hold?.tableId ?? null}
                        layout="rows"
                        sectionColors={sectionMapColors}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <span className="text-brand-700">
                  {t('reservationNew.legend.available')}
                </span>
                {availableSectionKeys.map((s) => (
                  <span
                    key={s}
                    aria-hidden
                    title={`Section ${s}`}
                    className="inline-block h-3 w-3 rounded-full"
                    style={{
                      background: sectionMapColors?.[s] ?? SECTION_COLORS[s] ?? '#9ca3af',
                    }}
                  />
                ))}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ background: '#9ca3af' }}
                />
                {t('reservationNew.legend.unavailable')}
              </span>
            </div>
          </section>
        ) : null}

      </div>

      {/* Bottom CTA bar — always visible while picking a table. Sits above the
          mobile keyboard via env() inset and the visualViewport listener
          handles soft-keyboard cases on iOS. */}
      {eventDate && !hold && !createdReservation && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
          style={{ paddingBottom: kbInset > 0 ? `${kbInset}px` : undefined }}
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <p className="text-sm text-brand-900">
              {selectedTable
                ? t('reservationNew.cta.selected', {
                    section: selectedTable.section,
                    id: selectedTable.id,
                    price: moneyFormatter.format(selectedTable.price),
                  })
                : t('reservationNew.cta.selectPrompt')}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPastModalOpen(true)}
                className="inline-flex h-10 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-brand-900 hover:bg-muted"
              >
                {t('reservationNew.changeEvent')}
              </button>
              <button
                type="button"
                onClick={confirmHoldSelected}
                disabled={!selectedTable || createHold.isPending}
                className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {createHold.isPending
                  ? t('common.saving')
                  : t('reservationNew.cta.holdAndReserve')}
              </button>
            </div>
          </div>
        </div>
      )}

      {(createdReservation || (hold && heldTable)) && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
          style={kbInset > 0 ? { paddingBottom: `${kbInset}px` } : undefined}
        >
          <div className="relative my-4 w-full max-w-3xl rounded-2xl bg-background p-5 shadow-xl">
            <header className="mb-4 flex items-baseline justify-between gap-3 border-b border-border pb-3">
              {hold && heldTable ? (
                <div>
                  <p className="text-sm font-semibold text-brand-900">
                    {t('reservationNew.heldTable', {
                      section: heldTable.section,
                      id: heldTable.id,
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {moneyFormatter.format(heldTable.price)}
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-semibold text-brand-900">
                    {t('reservationNew.postCreate.heading')}
                  </p>
                </div>
              )}
              <div className="flex items-center gap-2">
                {hold && !createdReservation && (
                  <span
                    className={`rounded-full border px-3 py-1 text-xs font-mono ${
                      expired
                        ? 'border-destructive bg-danger-100/40 text-destructive'
                        : 'border-border bg-muted/40 text-brand-900'
                    }`}
                  >
                    {expired
                      ? t('reservationNew.holdExpired')
                      : `${Math.floor(remainingSec / 60)}m ${String(remainingSec % 60).padStart(2, '0')}s`}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (createdReservation) {
                      setCreatedReservation(null);
                      return;
                    }
                    handleReleaseHold();
                  }}
                  aria-label={t('reservationNew.closeModal')}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-sm text-brand-900 hover:bg-muted"
                >
                  ✕
                </button>
              </div>
            </header>

            {createdReservation && (
              <PostCreatePanel
                reservation={createdReservation}
                isDigital={
                  createdReservation.paymentMethod === 'square' ||
                  createdReservation.paymentMethod === 'cashapp' ||
                  // Backend nulls paymentMethod when status is PENDING (digital
                  // flow + credit-with-remainder); fall back to the form choice.
                  ((createdReservation.paymentMethod ?? null) === null &&
                    (watchedMethod === 'square' || watchedMethod === 'cashapp'))
                }
                linkMode={
                  createdReservation.paymentMethod === 'cashapp' ||
                  ((createdReservation.paymentMethod ?? null) === null &&
                    watchedMethod === 'cashapp')
                    ? 'cashapp'
                    : 'square'
                }
                onDone={() =>
                  navigate(
                    `/staff/reservations/${createdReservation.eventDate}/${createdReservation.reservationId}`
                  )
                }
                onAnother={() => {
                  setCreatedReservation(null);
                  // Fresh form for the next reservation: clear customer info,
                  // payment selections, deposit, and the credit toggle.
                  // Restored deadline defaults will reapply on the next hold.
                  reset({
                    customerName: '',
                    phone: '',
                    phoneCountry: 'US',
                    paymentMethod: 'square',
                    paymentStatus: 'PENDING',
                    amountDue: 0,
                    depositAmount: 0,
                    paymentDeadlineDate: nextDayDateString(),
                    paymentDeadlineTime: '00:00',
                    packageId: '',
                    receiptNumber: '',
                  });
                  setAllowCustomDeposit(false);
                  setPaymentDeadlineEnabled(false);
                  setCreditEnabled(false);
                  setSelectedCreditId(null);
                  setDeadlineError(null);
                  setCreditApplyError(null);
                  setDeadlineDefaultsApplied(false);
                }}
              />
            )}

            {hold && heldTable && !expired && !createdReservation && (
              <form onSubmit={onSubmit} className="space-y-4">
                <h2 className="text-lg font-semibold text-brand-900">
                  {t('reservationNew.customerHeading')}
                </h2>
            <div className="grid grid-cols-[120px_1fr] gap-3">
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="phoneCountry"
                >
                  {t('reservationNew.field.phone')}
                </label>
                <select
                  id="phoneCountry"
                  aria-label={t('frequentClients.field.country')}
                  {...register('phoneCountry')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="MX">🇲🇽 +52</option>
                  <option value="US">🇺🇸 +1</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-transparent" htmlFor="phone">
                  &nbsp;
                </label>
                <input
                  id="phone"
                  type="tel"
                  placeholder="+528991234567"
                  {...register('phone', { required: true })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="customerName">
                {t('reservationNew.field.customerName')}
              </label>
              <input
                id="customerName"
                {...register('customerName', { required: true })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            {showCrmPanel && (
              <div className="rounded-md border border-border bg-muted/30 p-2">
                {crmSearch.isLoading ? (
                  <p className="text-xs text-muted-foreground">
                    {t('reservationNew.crm.searching')}
                  </p>
                ) : noCrmMatch ? (
                  <p className="text-xs text-muted-foreground">
                    {t('reservationNew.crm.noMatch')}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {crmMatches.slice(0, 5).map((c) => (
                      <li key={c.phone}>
                        <button
                          type="button"
                          onClick={() => applyCrmMatch(c)}
                          className="flex w-full items-baseline justify-between gap-2 rounded-md border border-border bg-background px-2 py-1 text-left text-sm hover:border-primary"
                        >
                          <span className="font-medium text-brand-900">
                            {c.name ?? '—'}
                          </span>
                          <span className="text-xs font-mono text-muted-foreground">
                            {formatPhoneForDisplay(c.phone)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {availableCredits.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
                <label className="flex items-start gap-2 text-brand-900">
                  <input
                    type="checkbox"
                    checked={creditEnabled}
                    onChange={(e) => setCreditEnabled(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-border"
                  />
                  <span className="flex-1">
                    <span className="font-semibold">
                      {t('reservationNew.credit.applyToggle', {
                        count: availableCredits.length,
                      })}
                    </span>
                  </span>
                </label>
                {creditEnabled && (
                  <div className="mt-2 space-y-2 pl-6">
                    {availableCredits.length > 1 && (
                      <select
                        value={selectedCreditId ?? ''}
                        onChange={(e) => setSelectedCreditId(e.target.value || null)}
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                      >
                        {availableCredits.map((c) => {
                          const remaining =
                            Number(c.amount ?? 0) - Number(c.amountUsed ?? 0);
                          return (
                            <option key={c.creditId} value={c.creditId}>
                              {moneyFormatter.format(remaining)}
                              {c.expiresAt ? ` · exp ${c.expiresAt}` : ''}
                            </option>
                          );
                        })}
                      </select>
                    )}
                    {selectedCredit && (
                      <p className="text-xs text-brand-700">
                        {t('reservationNew.credit.summary', {
                          applied: moneyFormatter.format(creditApplied),
                          remaining: moneyFormatter.format(creditRemainderDue),
                        })}
                      </p>
                    )}
                    {creditRemainderDue > 0.005 && (
                      <p className="text-xs text-muted-foreground">
                        {t('reservationNew.credit.remainderHint')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {(packages ?? []).filter((p) => p.status === 'ACTIVE').length > 0 && (
              <div>
                <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="packageId">
                  {t('reservationNew.field.package')}
                </label>
                <select
                  id="packageId"
                  {...register('packageId')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t('reservationNew.field.noPackage')}</option>
                  {(packages ?? [])
                    .filter((p) => p.status === 'ACTIVE')
                    .map((p) => (
                      <option key={p.packageId} value={p.packageId}>
                        {p.name} (+{moneyFormatter.format(p.priceUSD)})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div>
              <p className="mb-1 text-sm font-medium text-brand-900">
                {t('reservationNew.field.paymentMethod')} *
              </p>
              <div className="grid grid-cols-3 gap-2">
                {(['square', 'cashapp', 'cash'] as PaymentMethodChoice[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setValue('paymentMethod', m, { shouldDirty: true })}
                    className={`h-10 rounded-md border px-3 text-sm font-semibold transition ${
                      watchedMethod === m
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-brand-900 hover:bg-muted'
                    }`}
                  >
                    {t(`reservationNew.method.${m}`)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                className="mb-1 block text-sm font-medium text-brand-900"
                htmlFor="amountDue"
              >
                {t('reservationNew.field.amountDue')} *
              </label>
              <input
                id="amountDue"
                type="number"
                step="0.01"
                min="0"
                {...register('amountDue', { valueAsNumber: true, min: 0 })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('reservationNew.field.amountDueHint', {
                  table: moneyFormatter.format(tablePrice),
                })}
              </p>
            </div>

            {isDigital && (
              <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-brand-700">
                {t('reservationNew.digitalNotice', {
                  method: watchedMethod === 'square' ? 'Square' : 'Cash App',
                })}
              </p>
            )}

            {isCash && !creditEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    className="mb-1 block text-sm font-medium text-brand-900"
                    htmlFor="paymentStatus"
                  >
                    {t('reservationNew.field.paymentStatus')} *
                  </label>
                  <select
                    id="paymentStatus"
                    {...register('paymentStatus')}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="PAID">PAID</option>
                    <option value="PARTIAL">PARTIAL</option>
                    <option value="PENDING">PENDING</option>
                    <option value="COURTESY">COURTESY</option>
                  </select>
                </div>
                <div>
                  <label
                    className="mb-1 block text-sm font-medium text-brand-900"
                    htmlFor="depositAmount"
                  >
                    {t('reservationNew.field.deposit')} *
                  </label>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      id="depositAmount"
                      type="number"
                      step="0.01"
                      min="0"
                      readOnly={!allowCustomDeposit}
                      {...register('depositAmount', { valueAsNumber: true })}
                      className={`w-full rounded-md border border-border px-3 py-2 text-sm ${
                        allowCustomDeposit ? 'bg-background' : 'bg-muted/40'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setAllowCustomDeposit((v) => !v)}
                      className="inline-flex items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-brand-900 hover:bg-muted"
                    >
                      {allowCustomDeposit
                        ? t('reservationNew.deposit.lock')
                        : t('reservationNew.deposit.modify')}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('reservationNew.field.depositHint', {
                      min: moneyFormatter.format(minDeposit),
                      table: moneyFormatter.format(tablePrice),
                    })}
                  </p>
                </div>
              </div>
            )}

            {isDigital && !creditEnabled && (
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="depositAmount"
                >
                  {t('reservationNew.field.depositOptional')}
                </label>
                <input
                  id="depositAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  {...register('depositAmount', { valueAsNumber: true })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('reservationNew.field.depositOptionalHint')}
                </p>
              </div>
            )}

            <div className={creditEnabled && creditRemainderDue <= 0.005 ? 'hidden' : ''}>
              {!deadlineRequired && !creditEnabled && (
                <label className="mb-2 flex items-center gap-2 text-sm text-brand-900">
                  <input
                    type="checkbox"
                    checked={paymentDeadlineEnabled}
                    onChange={(e) => setPaymentDeadlineEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-border"
                  />
                  {t('reservationNew.field.deadlineToggle')}
                </label>
              )}
              {(paymentDeadlineEnabled || deadlineRequired) && (
                <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/20 p-3">
                  <div>
                    <label
                      className="mb-1 block text-xs text-brand-700"
                      htmlFor="paymentDeadlineDate"
                    >
                      {t('reservationNew.field.deadlineDate')}
                    </label>
                    <input
                      id="paymentDeadlineDate"
                      type="date"
                      {...register('paymentDeadlineDate')}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <label
                      className="mb-1 block text-xs text-brand-700"
                      htmlFor="paymentDeadlineTime"
                    >
                      {t('reservationNew.field.deadlineTime', { tz: operatingTz })}
                    </label>
                    <input
                      id="paymentDeadlineTime"
                      type="time"
                      {...register('paymentDeadlineTime')}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    />
                  </div>
                  <p className="col-span-2 text-xs text-muted-foreground">
                    {t('reservationNew.field.deadlineHint', {
                      tz: operatingTz,
                      time: `${pad2(defaultDeadlineHour)}:${pad2(defaultDeadlineMinute)}`,
                    })}
                  </p>
                  {deadlineError && (
                    <p
                      className="col-span-2 text-xs text-destructive"
                      role="alert"
                    >
                      {deadlineError}
                    </p>
                  )}
                </div>
              )}
            </div>

            {isCash && (
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="receiptNumber"
                >
                  {t('reservationNew.field.receiptNumber')}
                </label>
                <input
                  id="receiptNumber"
                  inputMode="numeric"
                  pattern="\d*"
                  {...register('receiptNumber')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            )}

            {phoneError && (
              <p className="text-sm text-destructive" role="alert">
                {phoneError}
              </p>
            )}
            {formError && (
              <p className="text-sm text-destructive" role="alert">
                {formError}
              </p>
            )}
            {submitError && (
              <p className="text-sm text-destructive" role="alert">
                {submitError}
              </p>
            )}
            {creditApplyError && (
              <p className="text-sm text-destructive" role="alert">
                {t('reservationNew.credit.applyFailed', { error: creditApplyError })}
              </p>
            )}

            <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-col-reverse gap-2 border-t border-border bg-background px-5 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3 sm:flex-row sm:items-center sm:justify-between">
              {heldTable && (
                <p className="text-xs text-muted-foreground">
                  {t('reservationNew.heldTable', {
                    section: heldTable.section,
                    id: heldTable.id,
                  })}
                  {' · '}
                  {moneyFormatter.format(Number(watchedAmountDue) || 0)}
                </p>
              )}
              <button
                type="submit"
                disabled={
                  createReservation.isPending ||
                  !depositValid ||
                  expired
                }
                className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:h-10"
              >
                {createReservation.isPending
                  ? t('common.saving')
                  : watchedMethod === 'square'
                    ? t('reservationNew.confirmCtaWith.square')
                    : watchedMethod === 'cashapp'
                      ? t('reservationNew.confirmCtaWith.cashapp')
                      : t('reservationNew.confirmCta')}
              </button>
            </div>
          </form>
        )}
          </div>
        </div>
      )}

      {pastModalOpen && (
        <div
          className="fixed inset-0 z-[55] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
        >
          <div className="my-4 w-full max-w-lg rounded-2xl bg-background p-5 shadow-xl">
            <header className="mb-3 flex items-baseline justify-between gap-3 border-b border-border pb-3">
              <h2 className="text-base font-semibold text-brand-900">
                {t('reservationNew.changeEventModal.title')}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setPastModalOpen(false);
                  setPastSearch('');
                }}
                aria-label={t('reservationNew.closeModal')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-sm text-brand-900 hover:bg-muted"
              >
                ✕
              </button>
            </header>
            <input
              type="search"
              value={pastSearch}
              onChange={(e) => setPastSearch(e.target.value)}
              placeholder={t('reservationNew.changeEventModal.searchPlaceholder')}
              className="mb-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            {(() => {
              const q = pastSearch.trim().toLowerCase();
              const matches = (e: typeof sortedEvents[number]) =>
                !q ||
                e.eventName.toLowerCase().includes(q) ||
                e.eventDate.includes(q);
              const upcoming = sortedEvents.filter(matches);
              const past = filteredPast;
              if (upcoming.length === 0 && past.length === 0) {
                return (
                  <p className="text-sm text-muted-foreground">
                    {t('reservationNew.changeEventModal.noMatch')}
                  </p>
                );
              }
              const renderItem = (e: typeof sortedEvents[number]) => {
                const current = e.eventDate === eventDate;
                const thisWeek =
                  e.eventDate >= todayStr && e.eventDate <= inAWeekStr;
                return (
                  <li key={e.eventId}>
                    <button
                      type="button"
                      disabled={current}
                      onClick={() => {
                        if (hold) {
                          setReleaseIntent({
                            kind: 'switchEvent',
                            nextEventDate: e.eventDate,
                          });
                        } else {
                          setEventDate(e.eventDate);
                        }
                        setPastModalOpen(false);
                        setPastSearch('');
                      }}
                      className={`flex w-full items-baseline justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                        current
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-background hover:border-primary'
                      }`}
                    >
                      <span className="flex flex-col">
                        <span className="font-medium text-brand-900">
                          {e.eventName}
                          {current && (
                            <span className="ml-2 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary-foreground">
                              {t('reservationNew.changeEventModal.current')}
                            </span>
                          )}
                          {thisWeek && !current && (
                            <span className="ml-2 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
                              {t('reservationNew.eventCard.thisWeek')}
                            </span>
                          )}
                        </span>
                        {Number(e.minDeposit ?? 0) > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            {t('reservationNew.minDeposit')}:{' '}
                            {moneyFormatter.format(e.minDeposit)}
                          </span>
                        )}
                      </span>
                      <span className="text-xs font-mono text-muted-foreground">
                        {e.eventDate}
                      </span>
                    </button>
                  </li>
                );
              };
              return (
                <div className="max-h-[60vh] space-y-3 overflow-y-auto">
                  {upcoming.length > 0 && (
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('reservationNew.changeEventModal.upcoming')}
                      </p>
                      <ul className="space-y-1">{upcoming.map(renderItem)}</ul>
                    </div>
                  )}
                  {past.length > 0 && (
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('reservationNew.changeEventModal.past')}
                      </p>
                      <ul className="space-y-1">{past.map(renderItem)}</ul>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {releaseIntent && hold && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-2xl bg-background p-5 shadow-xl">
            <h2 className="text-base font-semibold text-brand-900">
              {releaseIntent.kind === 'switchEvent'
                ? t('reservationNew.releaseConfirm.titleSwitch')
                : t('reservationNew.releaseConfirm.title')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {releaseIntent.kind === 'switchEvent'
                ? t('reservationNew.releaseConfirm.bodySwitch')
                : t('reservationNew.releaseConfirm.body')}
            </p>
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setReleaseIntent(null)}
                className="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-brand-900 hover:bg-muted"
              >
                {t('reservationNew.releaseConfirm.continue')}
              </button>
              <button
                type="button"
                onClick={confirmReleaseIntent}
                className="inline-flex items-center justify-center rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
              >
                {releaseIntent.kind === 'switchEvent'
                  ? t('reservationNew.releaseConfirm.releaseAndSwitch')
                  : t('reservationNew.releaseConfirm.release')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const SECTION_COLORS: Record<string, string> = {
  A: '#ec008c',
  B: '#2e3192',
  C: '#00aeef',
  D: '#f7941d',
  E: '#711411',
};

function TableListView({
  tables,
  disabled,
  onSelect,
  selectedTableId,
  layout = 'grid',
  sectionColors,
}: {
  tables: TableForEvent[];
  disabled: boolean;
  onSelect: (t: TableForEvent) => void;
  selectedTableId?: string | null;
  layout?: 'grid' | 'rows';
  sectionColors?: Record<string, string>;
}) {
  const { t, i18n } = useTranslation();
  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  const colorFor = (section: string) =>
    sectionColors?.[section] ?? SECTION_COLORS[section] ?? '#9ca3af';

  const grouped = useMemo(() => {
    const map = new Map<string, TableForEvent[]>();
    for (const tb of tables) {
      const arr = map.get(tb.section) ?? [];
      arr.push(tb);
      map.set(tb.section, arr);
    }
    for (const [, arr] of map) {
      arr.sort((a, b) => a.id.localeCompare(b.id));
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tables]);

  if (tables.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        {t('reservationNew.list.empty')}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {grouped.map(([section, arr]) => (
        <div key={section}>
          <p
            className="mb-1 text-xs font-semibold uppercase tracking-wide"
            style={{ color: colorFor(section) }}
          >
            {t('reservationNew.section', { section })}
          </p>
          <ul
            className={
              layout === 'rows'
                ? 'flex flex-col gap-1'
                : 'grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4'
            }
          >
            {arr.map((tb) => {
              const avail = tb.status === 'AVAILABLE';
              const isSelected = selectedTableId === tb.id;
              // Per-status row chrome — keeps the at-a-glance scanability the
              // Angular original had. AVAILABLE rows use the section accent
              // border; status'd rows use a status-specific border + tint.
              const statusClasses: Record<string, string> = {
                HOLD: 'border-amber-300 bg-amber-50 text-amber-900',
                PENDING_PAYMENT: 'border-orange-300 bg-orange-50 text-orange-900',
                RESERVED: 'border-rose-300 bg-rose-50 text-rose-900',
                DISABLED: 'border-border bg-muted/40 text-muted-foreground',
                UNAVAILABLE: 'border-border bg-muted/40 text-muted-foreground',
              };
              const statusPillClasses: Record<string, string> = {
                AVAILABLE: 'bg-success-100 text-success-700',
                HOLD: 'bg-amber-200 text-amber-900',
                PENDING_PAYMENT: 'bg-orange-200 text-orange-900',
                RESERVED: 'bg-rose-200 text-rose-900',
                DISABLED: 'bg-muted text-muted-foreground',
                UNAVAILABLE: 'bg-muted text-muted-foreground',
              };
              const statusClass = statusClasses[tb.status] ?? '';
              const pillClass = statusPillClasses[tb.status] ?? 'bg-muted text-muted-foreground';
              return (
                <li key={tb.id}>
                  <button
                    type="button"
                    disabled={!avail || disabled}
                    onClick={() => avail && onSelect(tb)}
                    aria-pressed={isSelected}
                    aria-label={`${tb.id} ${moneyFormatter.format(tb.price)} ${tb.status.replace(/_/g, ' ')}`}
                    className={`flex w-full items-baseline justify-between rounded-md border px-3 py-2 text-left text-sm transition focus:outline-none focus:ring-2 focus:ring-primary ${
                      isSelected
                        ? 'border-primary bg-primary/10 ring-2 ring-primary'
                        : avail
                          ? 'border-border bg-background hover:border-primary'
                          : `cursor-not-allowed ${statusClass}`
                    }`}
                    style={
                      avail && !isSelected
                        ? { borderLeft: `4px solid ${colorFor(section)}` }
                        : undefined
                    }
                  >
                    <span className="font-mono font-semibold">
                      {tb.id}
                    </span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className={avail ? 'text-muted-foreground' : 'opacity-90'}>
                        {moneyFormatter.format(tb.price)}
                      </span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${pillClass}`}>
                        {t(`reservationNew.list.status.${tb.status}`, {
                          defaultValue: tb.status.replace(/_/g, ' '),
                        })}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PostCreatePanel({
  reservation,
  isDigital,
  linkMode,
  onDone,
  onAnother,
}: {
  reservation: ReservationItem;
  isDigital: boolean;
  linkMode: 'square' | 'cashapp';
  onDone: () => void;
  onAnother: () => void;
}) {
  const { t, i18n } = useTranslation();
  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });
  const createSquareLink = useCreateSquarePaymentLink(
    reservation.reservationId,
    reservation.eventDate
  );
  const sendSquareSms = useSendSquareLinkSms(
    reservation.reservationId,
    reservation.eventDate
  );
  const createCashAppLink = useCreateCashAppLink(
    reservation.reservationId,
    reservation.eventDate
  );
  const sendCashAppSms = useSendCashAppLinkSms(
    reservation.reservationId,
    reservation.eventDate
  );
  const createLink = linkMode === 'cashapp' ? createCashAppLink : createSquareLink;
  const sendSms = linkMode === 'cashapp' ? sendCashAppSms : sendSquareSms;

  const linkUrl =
    linkMode === 'cashapp'
      ? createCashAppLink.data?.cashAppLink?.url ?? ''
      : createSquareLink.data?.paymentLinkUrl ?? reservation.paymentLinkUrl ?? '';
  const paidTotal = Array.isArray(reservation.payments)
    ? reservation.payments.reduce((sum, p) => sum + (Number(p?.amount) || 0), 0)
    : Number(reservation.depositAmount ?? 0);
  const remaining = Math.max(
    0,
    Number(reservation.amountDue ?? 0) - paidTotal
  );

  const message = t('reservationNew.share.message', {
    name: reservation.customerName,
    table: reservation.tableId,
    amount: moneyFormatter.format(remaining || (reservation.amountDue ?? 0)),
    url: linkUrl,
  });

  function copyLink() {
    if (!linkUrl) return;
    void navigator.clipboard.writeText(linkUrl);
  }
  function openWhatsApp() {
    if (!linkUrl) return;
    const phone = String(reservation.phone ?? '').replace(/\D/g, '');
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  }
  function nativeShare() {
    if (!linkUrl) return;
    if (navigator.share) {
      void navigator.share({ text: message, url: linkUrl });
    } else {
      copyLink();
    }
  }

  const apiError = createLink.error ?? sendSms.error;
  const errorMessage =
    apiError && 'status' in apiError && 'message' in apiError
      ? `${(apiError as { status: number }).status}: ${(apiError as { message: string }).message}`
      : null;

  return (
    <article className="rounded-lg border-2 border-success-200 bg-success-100/40 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-success-700">
            {t('reservationNew.postCreate.heading')}
          </h2>
          <p className="text-sm text-brand-700">
            {reservation.customerName} · {t('reservations.tableShort')}{' '}
            {reservation.tableId} · {moneyFormatter.format(reservation.amountDue ?? 0)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onAnother}
            className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted"
          >
            {t('reservationNew.postCreate.another')}
          </button>
          <button
            type="button"
            onClick={onDone}
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('reservationNew.postCreate.viewDetail')}
          </button>
        </div>
      </div>

      {isDigital && remaining > 0 && (
        <div className="mt-4 space-y-3 rounded-md border border-border bg-background p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold text-brand-900">
              {linkMode === 'cashapp'
                ? t('reservationNew.postCreate.linkHeadingCashApp')
                : t('reservationNew.postCreate.linkHeading')}
            </p>
            <button
              type="button"
              onClick={() => createLink.mutate({ eventDate: reservation.eventDate })}
              disabled={createLink.isPending}
              className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createLink.isPending
                ? t('common.saving')
                : linkUrl
                  ? t('reservationNew.postCreate.regenerate')
                  : t('reservationNew.postCreate.generate')}
            </button>
          </div>

          {linkUrl ? (
            <>
              <input
                type="text"
                readOnly
                value={linkUrl}
                className="w-full rounded-md border border-border bg-muted/40 px-2 py-1 text-xs font-mono text-brand-900"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copyLink}
                  className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted"
                >
                  {t('reservationNew.postCreate.copy')}
                </button>
                <button
                  type="button"
                  onClick={() => sendSms.mutate()}
                  disabled={sendSms.isPending}
                  className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted disabled:opacity-50"
                >
                  {sendSms.isPending
                    ? t('common.saving')
                    : t('reservationNew.postCreate.sms')}
                </button>
                <button
                  type="button"
                  onClick={openWhatsApp}
                  className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted"
                >
                  {t('reservationNew.postCreate.whatsApp')}
                </button>
                <button
                  type="button"
                  onClick={nativeShare}
                  className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted"
                >
                  {t('reservationNew.postCreate.share')}
                </button>
              </div>
              {sendSms.isSuccess && (
                <p className="text-xs text-success-700">
                  {t('reservationNew.postCreate.smsSent')}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('reservationNew.postCreate.linkHint')}
            </p>
          )}
          {errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}
        </div>
      )}

      {!isDigital && (
        <p className="mt-4 text-sm text-brand-700">
          {t('reservationNew.postCreate.cashSummary')}
        </p>
      )}
    </article>
  );
}
