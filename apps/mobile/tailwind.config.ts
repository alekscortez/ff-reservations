import type { Config } from 'tailwindcss';
import { brandColors, accentColors, successColors, dangerColors } from '@ff/core';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        brand: brandColors,
        accent: accentColors,
        success: successColors,
        danger: dangerColors,
      },
    },
  },
  plugins: [],
};

export default config;
