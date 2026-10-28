import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', 'pg', 'pg-*', '**/application/**', '**/db/**', '**/api/**'],
              message: 'domain/ must stay framework-free and import nothing from outer layers.',
            },
          ],
        },
      ],
    },
  },
];
