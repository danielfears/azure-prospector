import tailwindAnimate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--cp-bg)',
        foreground: 'var(--cp-text)',
        border: 'var(--cp-border)',
        input: 'var(--cp-border)',
        ring: 'var(--cp-accent)',
        card: {
          DEFAULT: 'var(--cp-surface)',
          foreground: 'var(--cp-text)',
        },
        popover: {
          DEFAULT: 'var(--cp-surface)',
          foreground: 'var(--cp-text)',
        },
        primary: {
          DEFAULT: 'var(--cp-accent)',
          foreground: 'var(--cp-accent-fg)',
        },
        secondary: {
          DEFAULT: 'var(--cp-surface-soft)',
          foreground: 'var(--cp-text)',
        },
        muted: {
          DEFAULT: 'var(--cp-surface-soft)',
          foreground: 'var(--cp-text-muted)',
        },
        accent: {
          DEFAULT: 'var(--cp-accent-soft)',
          foreground: 'var(--cp-accent)',
        },
        destructive: {
          DEFAULT: 'var(--cp-danger)',
          foreground: 'var(--cp-accent-fg)',
        },
        success: 'var(--cp-success)',
        warning: 'var(--cp-warning)',
        link: 'var(--cp-link)',
      },
      borderRadius: {
        lg: '0.625rem',
        md: '0.625rem',
        sm: '0.5rem',
        xl: '1rem',
      },
      boxShadow: {
        card: '0 0 2px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.14)',
      },
    },
  },
  plugins: [tailwindAnimate],
}
