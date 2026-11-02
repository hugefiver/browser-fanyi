import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled'] },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'], environment: 'jsdom', restoreMocks: true,
    deps: { optimizer: { web: { enabled: true, include: ['react', 'react-dom/client', '@testing-library/react', '@mui/material'] } } },
  },
});
