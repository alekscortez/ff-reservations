/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
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
        accent: {
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
          500: '#10b981',
          700: '#047857',
        },
        danger: {
          50: '#fef2f2',
          100: '#fee2e2',
          500: '#ef4444',
          700: '#b91c1c',
        },
      },
    },
  },
  plugins: [],
};
