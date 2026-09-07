/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Outfit',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
          '"Segoe UI Symbol"',
          '"Noto Color Emoji"',
        ],
      },
      borderRadius: {
        md: '12px',
        lg: '16px',
      },
      boxShadow: {
        sm: '0 1px 2px 0 rgba(18, 23, 33, 0.04), 0 4px 12px -2px rgba(18, 23, 33, 0.05)',
        lg: '0 10px 30px -8px rgba(18, 23, 33, 0.10), 0 4px 12px -4px rgba(18, 23, 33, 0.06)',
      },
      colors: {
        blue: {
          50:  '#EEF2FF',
          100: '#DEE5FE',
          200: '#C0CCFC',
          300: '#94A8F8',
          400: '#6580F4',
          500: '#4870F0',
          600: '#3462EE',
          700: '#2648C2',
          800: '#1F3A9C',
          900: '#172C74',
          950: '#0F1C4B',
        },
        slate: {
          50:  '#F7F8F2',
          900: '#121721',
        },
      },
    },
  },
  plugins: [],
};
