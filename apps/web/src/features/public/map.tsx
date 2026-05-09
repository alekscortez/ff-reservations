import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePublicAvailability, type PublicTable } from '@/lib/api/availability';

const SVG_URL = '/maps/FF_Reservations_Map.normalized.svg';

function applyStatusToSvg(container: HTMLElement | null, tables: PublicTable[]) {
  if (!container) return;
  const svg = container.querySelector('svg');
  if (!svg) return;

  for (const table of tables) {
    const node = svg.querySelector(`g[id="${table.id}"]`);
    if (node) {
      node.setAttribute('data-status', table.status);
    }
  }
}

function fmtClock(epoch: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(epoch * 1000));
}

export function PublicMap() {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [svgLoaded, setSvgLoaded] = useState(false);

  const eventDate = search.get('eventDate');
  const { data, isLoading, error } = usePublicAvailability(eventDate);

  useEffect(() => {
    let cancelled = false;
    fetch(SVG_URL)
      .then((res) => res.text())
      .then((svgText) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svgText;
        setSvgLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSvgLoaded(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (svgLoaded && data?.tables) {
      applyStatusToSvg(containerRef.current, data.tables);
    }
  }, [svgLoaded, data?.tables]);

  const moneyFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' }),
    [i18n.language]
  );
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      }),
    [i18n.language]
  );

  const eventOptions = data?.events ?? [];
  const selectedDate = data?.event.eventDate ?? eventDate ?? '';

  const sectionsBreakdown = useMemo(() => {
    if (!data?.tables) return [] as { section: string; total: number; available: number }[];
    const map = new Map<string, { total: number; available: number }>();
    for (const t of data.tables) {
      const cur = map.get(t.section) ?? { total: 0, available: 0 };
      cur.total += 1;
      if (t.available) cur.available += 1;
      map.set(t.section, cur);
    }
    return [...map.entries()]
      .map(([section, c]) => ({ section, ...c }))
      .sort((a, b) => a.section.localeCompare(b.section));
  }, [data?.tables]);

  return (
    <main className="min-h-screen bg-brand-50 p-4 sm:p-6">
      <style>{`
        svg g[data-status="AVAILABLE"] > g:first-of-type > path:first-of-type { fill: #16a34a; }
        svg g[data-status="UNAVAILABLE"] > g:first-of-type > path:first-of-type { fill: #9ca3af; }
        svg { width: 100%; height: auto; max-height: 70vh; }
      `}</style>

      <div className="mx-auto max-w-5xl">
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-brand-900 sm:text-3xl">
              {t('publicMap.title')}
            </h1>
            {data?.event && (
              <p className="text-sm text-muted-foreground">
                {dateFormatter.format(new Date(data.event.eventDate + 'T00:00:00'))} ·{' '}
                {data.event.eventName}
              </p>
            )}
          </div>

          {eventOptions.length > 1 && (
            <select
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={selectedDate}
              onChange={(e) => {
                const next = new URLSearchParams(search);
                next.set('eventDate', e.target.value);
                setSearch(next);
              }}
            >
              {eventOptions.map((evt) => (
                <option key={evt.eventDate} value={evt.eventDate}>
                  {dateFormatter.format(new Date(evt.eventDate + 'T00:00:00'))} —{' '}
                  {evt.eventName}
                </option>
              ))}
            </select>
          )}
        </header>

        <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border bg-background p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('publicMap.totalTables')}</p>
            <p className="text-2xl font-semibold text-brand-900">
              {data?.counts.total ?? '—'}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('publicMap.available')}</p>
            <p className="text-2xl font-semibold text-success-700">
              {data?.counts.available ?? '—'}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('publicMap.unavailable')}</p>
            <p className="text-2xl font-semibold text-muted-foreground">
              {data?.counts.unavailable ?? '—'}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3 text-center">
            <p className="text-xs text-muted-foreground">{t('publicMap.lastUpdated')}</p>
            <p className="text-sm font-medium text-brand-900">
              {data ? fmtClock(data.asOfEpoch) : '—'}
            </p>
          </div>
        </section>

        <section className="mt-4 rounded-lg border border-border bg-background p-4">
          {isLoading && !svgLoaded ? (
            <p className="text-muted-foreground">{t('common.loading')}</p>
          ) : error ? (
            <p className="text-destructive">{t('common.error')}</p>
          ) : null}
          <div ref={containerRef} className="overflow-auto" />
        </section>

        {sectionsBreakdown.length > 0 && (
          <section className="mt-4 rounded-lg border border-border bg-background p-4">
            <h2 className="text-sm font-semibold text-brand-900">
              {t('publicMap.sectionsHeading')}
            </h2>
            <ul className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {sectionsBreakdown.map((s) => (
                <li key={s.section} className="flex items-baseline justify-between gap-2">
                  <span className="text-muted-foreground">{s.section}</span>
                  <span>
                    <span className="font-semibold text-success-700">{s.available}</span>{' '}
                    <span className="text-muted-foreground">/ {s.total}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data?.tables && data.tables.length > 0 && (
          <p className="mt-4 text-center text-xs text-muted-foreground">
            {t('publicMap.priceRangeHint', {
              min: moneyFormatter.format(
                Math.min(...data.tables.map((tb) => tb.price ?? 0).filter((n) => n > 0))
              ),
              max: moneyFormatter.format(Math.max(...data.tables.map((tb) => tb.price ?? 0))),
            })}
          </p>
        )}
      </div>
    </main>
  );
}
