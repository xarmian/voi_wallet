# Contributing to Voi Wallet

Thank you for your interest in contributing to Voi Wallet! This document provides guidelines and information for contributors.

## 📋 Table of Contents

- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Testing Guidelines](#testing-guidelines)
- [Security Considerations](#security-considerations)

## 🚀 Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/voi-wallet.git`
3. Install dependencies: `npm install`
4. Create a feature branch: `git checkout -b feature/your-feature-name`
5. Start developing: `npm start`

## 📁 Project Structure

```
voi-wallet/
├── src/
│   ├── components/     # Reusable UI components
│   ├── screens/        # Screen components (named *Screen.tsx)
│   ├── navigation/     # Navigation configuration
│   ├── services/       # Business logic and API integrations
│   ├── store/          # Zustand state management
│   ├── contexts/       # React contexts (e.g., AuthContext)
│   ├── hooks/          # Custom React hooks (prefix with 'use')
│   ├── utils/          # Utility functions
│   ├── types/          # TypeScript type definitions
│   └── config/         # App configuration
├── assets/             # Images, fonts, static assets
├── App.tsx             # Application entry point
└── app.config.js       # Expo configuration
```

### Module Organization

- **Entry Points**: `App.tsx` (Expo app), `index.ts` (main export)
- **Feature Organization**: Group related files by feature/domain
- **Build Output**: `dist/` (do not edit directly)
- **Planning**: Internal `planning/` directory (not included in public repo)

## 🛠️ Development Workflow

### Available Commands

```bash
npm start                # Launch Expo dev server
npm run ios              # Start iOS simulator
npm run android          # Start Android emulator
npm run web              # Start web version
npm run lint             # Lint TypeScript with ESLint
npm run lint:fix         # Auto-fix linting issues
npm run format           # Format code with Prettier
npm run typecheck        # TypeScript type checking
```

### Before Committing

Ensure all checks pass:

```bash
npm run lint
npm run format
npm run typecheck
```

## 📝 Coding Standards

### TypeScript & Formatting

- **Language**: TypeScript for all code
- **Indentation**: 2 spaces (no tabs)
- **Linting**: ESLint with `@typescript-eslint` config
- **Formatting**: Prettier (run `npm run format`)
- **Type Safety**: Prefer strict typing, avoid `any` when possible

### Naming Conventions

- **Components**: PascalCase (e.g., `AuthGuard.tsx`, `AccountListItem.tsx`)
- **Utilities**: camelCase (e.g., `bigint.ts`, `clipboard.ts`)
- **Hooks**: Prefix with `use` (e.g., `useSomething.ts`)
- **Screens**: PascalCase with `Screen` suffix (e.g., `HomeScreen.tsx`)
- **Exports**: Prefer named exports; default exports allowed for screen components

### File Organization

- **Components**: `src/components/<feature>/<ComponentName>.tsx`
- **Screens**: `src/screens/<area>/<ScreenName>Screen.tsx`
- **Services**: `src/services/<domain>/index.ts`
- **Types**: Shared types in `src/types/`, local types in same file

## 🔄 Commit Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): subject

[optional body]

[optional footer]
```

### Commit Types

- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code refactoring
- `chore`: Maintenance tasks
- `docs`: Documentation changes
- `test`: Test additions or modifications
- `style`: Code style changes (formatting, etc.)
- `perf`: Performance improvements

### Examples

```bash
feat(wallet): add transaction tracker
fix(auth): resolve PIN verification issue
refactor(services): simplify network configuration
docs(readme): update installation instructions
chore(deps): update algosdk to latest version
```

## 🔀 Pull Request Process

### Before Submitting

1. Ensure all tests pass (when tests are configured)
2. Run `npm run lint` and `npm run typecheck`
3. Update documentation if needed
4. Keep PRs focused on a single feature/fix
5. Aim for PRs under ~300 lines of code

### PR Description Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
How was this tested?

## Screenshots (if applicable)
Add screenshots for UI changes

## Related Issues
Closes #123
```

### Review Process

- All PRs require review before merging
- Address reviewer feedback promptly
- Keep discussions respectful and constructive

## 🧪 Testing Guidelines

### Testing Strategy

- Tests are not yet fully configured
- When adding tests, prefer Jest + React Testing Library
- Test location: Colocate `*.test.ts(x)` next to sources or use `src/__tests__/`
- Keep tests deterministic
- Mock native modules and external dependencies

### Testing Checklist

- [ ] Unit tests for business logic
- [ ] Component tests for UI components
- [ ] Integration tests for critical flows
- [ ] Manual testing on iOS and Android

## 🔒 Security Considerations

### Critical Rules

⚠️ **NEVER**:
- Log secrets, private keys, or PINs in console
- Commit credentials or API keys
- Store sensitive data in AsyncStorage (use SecureStore)
- Hardcode environment-specific values

✅ **ALWAYS**:
- Use `expo-secure-store` for sensitive data (see `src/services/secure/`)
- Follow Algorand standards for crypto operations
- Require authentication for transaction signing
- Validate all user inputs
- Handle errors gracefully without exposing sensitive info

### Security Review Required

All PRs involving these areas require security review:
- Cryptographic operations
- Key management or storage
- Transaction signing
- Authentication flows
- Network requests with sensitive data

## 🎯 Common Patterns & Best Practices

### Zustand Store Usage

❌ **NEVER** use object destructuring:
```typescript
// BAD - Causes infinite re-renders
const { wallet, accounts } = useWalletStore();
```

✅ **ALWAYS** use individual selectors:
```typescript
// GOOD - Stable references
const wallet = useWalletStore(state => state.wallet);
const accounts = useWalletStore(state => state.accounts);
```

See [GOTCHA.md](GOTCHA.md) for more patterns and pitfalls.

### BigInt Handling

- Use `number | bigint` types for Algorand amounts
- Prefer nullish coalescing (`??`) over logical OR (`||`)
- Never coerce BigInt to number without explicit conversion

### Async Operations

- Mark functions as `async` when using `await`
- Handle Promise rejections properly
- Use error boundaries for React components

## 📚 Architecture Guidelines

### Navigation

- Navigation config in `src/navigation/`
- Use typed navigation parameters
- Follow React Navigation patterns

### State Management

- Global state: Zustand stores in `src/store/`
- Local state: React hooks (`useState`, `useReducer`)
- Side effects in `src/services/`

### API Integration

- Network operations flow through `src/services/`
- Isolate side effects from UI components
- Use proper error handling and retries

### Configuration

- App config in `src/config/`
- Network configurations in `src/services/network/config.ts`
- Avoid hardcoding values

## 🐛 Debugging Tips

- Check [GOTCHA.md](GOTCHA.md) for common issues
- Use React DevTools for component inspection
- Enable Expo Dev Tools for debugging
- Check Ledger-specific logs in debug logger

## 💡 Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Join community discussions
- Review documentation in the repository

## 📄 Code of Conduct

- Be respectful and inclusive
- Welcome newcomers
- Focus on constructive feedback
- Collaborate openly

---

Thank you for contributing to Voi Wallet! 🎉
