import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useEventContext } from '@/lib/api/settings';

function LanguageToggle() {
  const { i18n } = useTranslation();
  const current = i18n.language?.startsWith('es') ? 'es' : 'en';
  return (
    <div className="inline-flex rounded-md border border-border bg-background text-xs">
      <button
        type="button"
        onClick={() => void i18n.changeLanguage('en')}
        className={`px-2 py-1 ${
          current === 'en'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => void i18n.changeLanguage('es')}
        className={`px-2 py-1 ${
          current === 'es'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        ES
      </button>
    </div>
  );
}

function TodayPill() {
  const { t } = useTranslation();
  const { data: ctx } = useEventContext();
  const todayEvent = ctx?.event ?? ctx?.nextEvent;
  if (!todayEvent) return null;
  const eventDate = todayEvent.eventDate;
  const m = eventDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let badge = eventDate;
  if (m) {
    const month = new Date(`${eventDate}T00:00:00`).toLocaleString(undefined, {
      month: 'short',
    });
    badge = `${month.toUpperCase()} ${Number(m[3])}`;
  }
  const labelKey = ctx?.event ? 'header.todayLabel' : 'header.nextLabel';
  return (
    <div className="hidden items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium sm:flex">
      <span className="text-muted-foreground">{t(labelKey)}:</span>
      <span className="text-foreground">{todayEvent.eventName}</span>
      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {badge}
      </span>
    </div>
  );
}

export function SiteHeader() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-2 px-4 lg:gap-3 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <TodayPill />
        <div className="ml-auto flex items-center gap-2">
          <LanguageToggle />
          <Button
            type="button"
            variant="default"
            size="sm"
            className="hidden sm:inline-flex"
            onClick={() => navigate('/staff/reservations/new')}
          >
            + {t('reservationNew.cta')}
          </Button>
        </div>
      </div>
    </header>
  );
}
