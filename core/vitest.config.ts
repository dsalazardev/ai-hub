import { defineConfig } from 'vitest/config';
import { CATALOG_INDEX_FILE } from './tests/catalog-index-file.js';

export default defineConfig({
  test: {
    reporters: ['verbose'],
    slowTestThreshold: 3000,
    globalSetup: ['./tests/global-setup.ts'],
    env: {
      AI_HUB_CATALOG_INDEX_FILE: CATALOG_INDEX_FILE,
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [
            'tests/cli.test.ts',
            'tests/pack.test.ts',
            'tests/brand.test.ts',
            'tests/gates.test.ts',
            'tests/install-generic.test.ts',
            'tests/install-angular.test.ts',
            'tests/speckit-preflight.test.ts',
            'tests/speckit-install.test.ts',
            'tests/speckit-real.test.ts',
            'tests/measured-counts.test.ts',
            'tests/speckit-doctor.test.ts',
          ],
          testTimeout: 10000,
          hookTimeout: 10000,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'tests/cli.test.ts',
            'tests/pack.test.ts',
            'tests/brand.test.ts',
            'tests/gates.test.ts',
            'tests/install-generic.test.ts',
            'tests/install-angular.test.ts',
            'tests/speckit-preflight.test.ts',
            'tests/speckit-install.test.ts',
            'tests/speckit-real.test.ts',
            'tests/measured-counts.test.ts',
            'tests/speckit-doctor.test.ts',
          ],
          testTimeout: 60000,
          hookTimeout: 60000,
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
