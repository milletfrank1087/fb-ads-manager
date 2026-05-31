/* Tailwind CDN runtime config. Loaded right after the Tailwind CDN script and
   before the page body so custom theme tokens are available during JIT. */
tailwind.config = {
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'monospace'] },
      colors: {
        meta: {
          blue: '#1877F2',
          green: '#42B72A',
          gray: { 50: '#F5F6F7', 100: '#EBEDF0', 600: '#65676B', 900: '#1C1E21' },
        },
      },
    },
  },
};
