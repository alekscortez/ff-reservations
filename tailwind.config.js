/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{html,ts}',
    // Spartan/helm components copied into the workspace under src/app/shared/ui/
    // also live in src/, so the glob above already covers them. Adding the
    // explicit path is harmless and makes the intent obvious if helm is ever
    // moved out of src/.
    './src/app/shared/ui/**/*.{html,ts}',
  ],
  theme: {
    extend: {
      colors: {
        // App palette (long-lived design tokens; existing classes keep working)
        brand: {
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
        },
        // 'warm' was previously named 'accent'. Renamed to free the 'accent'
        // namespace for Spartan/shadcn's semantic accent color. See styles.scss.
        warm: {
          50: '#fff7e6',
          100: '#ffe8bf',
          200: '#ffd28a',
          300: '#ffb84d',
          400: '#ffa726',
          500: '#f59f00',
          600: '#d48800',
          700: '#a56100',
          800: '#7a4c00',
          900: '#4d2f00',
        },
        success: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          500: '#10b981',
          700: '#047857',
          800: '#065f46',
        },
        danger: {
          50: '#fef2f2',
          100: '#fee2e2',
          200: '#fecaca',
          300: '#fca5a5',
          400: '#f87171',
          500: '#ef4444',
          700: '#b91c1c',
          800: '#991b1b',
        },
        // Warning (amber). Referenced in templates since at least early
        // 2026 (text-warning-700, border-warning-300, bg-warning-100,
        // etc.) but the palette was never defined in tailwind.config.js
        // — those classes silently produced no CSS. Restored in
        // Phase 6d while building the HlmToggle warning variant.
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          500: '#f59e0b',
          700: '#b45309',
          800: '#92400e',
        },
        // Success — extended with shades that templates reference
        // (bg-success-200/300, border-success-300, text-success-800)
        // but the original config only defined 50/100/500/700.
        // Same silently-no-CSS bug as warning above.

        // Spartan / shadcn semantic colors — resolve via CSS variables in
        // styles.scss. helm components reference these via classes like
        // bg-primary, text-muted-foreground, ring-ring, border-border.
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
