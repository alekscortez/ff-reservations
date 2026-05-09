import { Stack } from 'expo-router';
import '../src/styles/globals.css';
import '../src/i18n';

export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
