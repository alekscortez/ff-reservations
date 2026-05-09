import { Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

function HomePlaceholder() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-50 p-8">
      <div className="max-w-xl text-center">
        <h1 className="text-3xl font-semibold text-brand-900">{t('app.title')}</h1>
        <p className="mt-3 text-brand-700">{t('app.scaffoldNotice')}</p>
      </div>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<HomePlaceholder />} />
      <Route path="*" element={<HomePlaceholder />} />
    </Routes>
  );
}
