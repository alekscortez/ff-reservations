import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

export default function Home() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center bg-brand-50 p-6">
      <Text className="text-2xl font-semibold text-brand-900">{t('app.title')}</Text>
      <Text className="mt-3 text-base text-brand-900/70">{t('app.scaffoldNotice')}</Text>
    </View>
  );
}
