module.exports = {
  root: true,
  extends: ['@intent/eslint-config/base'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    'import/export': 'off',
  },
}
