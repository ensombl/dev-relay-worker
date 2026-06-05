import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		coverage: {
			provider: 'istanbul',
			include: ['src/**/*.ts'],
			reporter: ['text', 'html', 'lcov'],
			thresholds: {
				statements: 99,
				branches: 86,
				functions: 100,
				lines: 100,
			},
		},
		poolOptions: {
			workers: {
				isolatedStorage: false,
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
