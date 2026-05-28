module.exports = {
  '*.{ts,tsx}': ['eslint --fix', 'prettier --write'],
  '*.{js,jsx}': ['prettier --write'],
  '*.{json,md,yaml,yml}': ['prettier --write'],
  '*.sol': ['forge fmt'],
  '*.go': ['gofmt -w'],
}