# Contributing to claude-discord-bridge

Thank you for considering a contribution! This document explains how to get started.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/anthropics/claude-discord-bridge.git
cd claude-discord-bridge

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Fill in DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID

# Validate your config
node daemon/bin/claude-discord-bridge.js --check

# Run tests
npm test
```

## Project Structure

- `daemon/core/` -- core modules (each file is a single-responsibility factory)
- `daemon/templates/` -- i18n messages and Claude prompt templates
- `daemon/addons/` -- drop-in addon modules
- `daemon/tests/` -- unit tests (vitest)
- `scripts/` -- utility scripts

## Code Style

- ES Modules (`import`/`export`)
- Factory function pattern with dependency injection (no global state)
- Immutable config objects (`Object.freeze`)
- JSDoc for public APIs
- No `console.log` in library code -- use the logger module

## Making Changes

1. **Fork** the repository and create a feature branch from `master`.
2. **Write tests first** if adding new functionality.
3. **Run `npm test`** and ensure all tests pass.
4. **Keep commits focused** -- one logical change per commit.
5. **Use conventional commit messages**: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.

## Pull Request Process

1. Update documentation if you change public APIs or configuration.
2. Add or update tests for new functionality.
3. Ensure CI passes (tests across Node 18, 20, 22).
4. Describe your changes clearly in the PR description.

## Adding an Addon

See the [Addon System](README.md#addon-system) section in the README. Place your addon in `daemon/addons/<name>/index.js` with a `register` export.

## Adding a Locale

1. Create `daemon/templates/messages/<locale>.json` based on `en.json`.
2. Translate all message keys.
3. Update the `LOCALE` documentation in `.env.example` and `README.md`.

## Reporting Issues

- Include your Node.js version, OS, and Claude Code CLI version.
- Include relevant log output (from `logs/` directory or PM2 logs).
- For security issues, please email maintainers directly instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
