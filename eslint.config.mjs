import next from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  {
    // `.claude/**` holds installed tooling and skill assets, not application source.
    ignores: ['.next/**', 'dist/**', 'node_modules/**', 'next-env.d.ts', '.claude/**'],
  },
  ...next,
  ...nextTypescript,
];

export default config;
