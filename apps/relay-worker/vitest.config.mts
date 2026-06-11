import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
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
	},
});
