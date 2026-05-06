import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Arc-inspired palette
        ink:    { DEFAULT: '#0B0518', soft: '#1A0F2E', deep: '#06030F' },
        cream:  { DEFAULT: '#FAF6FF', soft: '#F4EEFE' },
        pink:   { DEFAULT: '#FF6B9D', soft: '#FFB3CC', deep: '#D63384' },
        lilac:  { DEFAULT: '#A78BFA', soft: '#C4B5FD', deep: '#7C3AED' },
        sky:    { DEFAULT: '#60A5FA', soft: '#93C5FD', deep: '#2563EB' },
        mint:   { DEFAULT: '#4ECDC4', soft: '#7DD3CD', deep: '#0D9488' },
        sun:    { DEFAULT: '#FBBF24', soft: '#FDE68A', deep: '#D97706' },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
        display: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      backdropBlur: {
        xs: '2px',
      },
      boxShadow: {
        'glass':       '0 8px 32px 0 rgba(31, 38, 135, 0.15)',
        'glass-pink':  '0 8px 32px 0 rgba(255, 107, 157, 0.20)',
        'glass-lilac': '0 8px 32px 0 rgba(167, 139, 250, 0.20)',
        'glow-pink':   '0 0 24px rgba(255, 107, 157, 0.55), 0 0 48px rgba(255, 107, 157, 0.25)',
        'glow-lilac':  '0 0 24px rgba(167, 139, 250, 0.55), 0 0 48px rgba(167, 139, 250, 0.25)',
        'soft':        '0 2px 8px rgba(11, 5, 24, 0.06)',
        'soft-lg':     '0 12px 40px rgba(11, 5, 24, 0.10)',
      },
      animation: {
        'shimmer':       'shimmer 2.5s ease-in-out infinite',
        'pulse-soft':    'pulseSoft 2s ease-in-out infinite',
        'float':         'float 6s ease-in-out infinite',
        'gradient-x':    'gradientX 8s ease infinite',
        'spin-slow':     'spin 4s linear infinite',
        'fade-in':       'fadeIn 0.4s ease-out',
        'cursor-blink':  'cursorBlink 1s step-end infinite',
      },
      keyframes: {
        shimmer: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%':       { backgroundPosition: '100% 50%' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '0.7' },
          '50%':       { opacity: '1' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%':       { transform: 'translateY(-10px)' },
        },
        gradientX: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%':       { backgroundPosition: '100% 50%' },
        },
        fadeIn: {
          '0%':   { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        cursorBlink: {
          '0%, 50%':   { opacity: '1' },
          '50.01%, 100%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
