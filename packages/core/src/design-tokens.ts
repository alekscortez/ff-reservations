export const brandColors = {
  50: '#f7f7f7',
  100: '#eeeeee',
  200: '#d9d9d9',
  300: '#bdbdbd',
  400: '#9d9d9d',
  500: '#7a7a7a',
  600: '#555555',
  700: '#333333',
  800: '#1a1a1a',
  900: '#0b0b0b',
} as const;

export const accentColors = {
  500: '#f59f00',
} as const;

export const successColors = {
  50: '#ecfdf5',
  100: '#d1fae5',
  500: '#10b981',
  700: '#047857',
} as const;

export const dangerColors = {
  50: '#fef2f2',
  100: '#fee2e2',
  500: '#ef4444',
  700: '#b91c1c',
} as const;

export const designTokens = {
  colors: {
    brand: brandColors,
    accent: accentColors,
    success: successColors,
    danger: dangerColors,
  },
} as const;

export type DesignTokens = typeof designTokens;
