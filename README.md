![Voi Wallet Logo](assets/voi_wallet_logo_crop.png)

# Voi Wallet

A production-ready mobile wallet for the Voi Network and Algorand blockchain ecosystem. Built with React Native, Expo, and TypeScript.

## 🌟 Features

- **Multi-Account Support**: Create, import, and manage multiple accounts
- **Ledger Hardware Wallet**: Full support for Ledger device integration via Bluetooth
- **WalletConnect v2**: Connect to dApps securely
- **ARC-200 & ARC-72**: Support for fungible and non-fungible tokens
- **Network Switching**: Seamless switching between Voi Network and Algorand Mainnet
- **Envoi Integration**: Human-readable names for addresses
- **Transaction History**: Complete transaction tracking and details
- **Secure Storage**: PIN protection and biometric authentication
- **Account Rekeying**: Advanced account security features

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or later recommended)
- npm or yarn
- Expo CLI
- iOS Simulator (macOS) or Android Emulator

### Installation

```bash
# Clone the repository
git clone https://github.com/xarmain/voi-wallet.git
cd voi-wallet

# Install dependencies
npm install

# Start the development server
npm start
```

### Environment Variables

The app expects a WalletConnect v2 project ID at build time. Set the environment variable before running or building:

```bash
export EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id
npm start
```

For EAS builds, configure the same variable (or `WALLETCONNECT_PROJECT_ID`) via `eas secret:create` or the `env` block in `eas.json`.

### Running the App

```bash
# iOS
npm run ios

# Android
npm run android

# Web
npm run web
```

## 🏗️ Building

### Development Builds

```bash
# Build for Android (APK)
eas build --platform android --profile preview

# Build for iOS (IPA)
eas build --platform ios --profile preview

# Build for both platforms
eas build --platform all --profile preview
```

### Production Builds

```bash
# Android (AAB for Play Store)
eas build --platform android --profile production

# iOS (IPA for App Store)
eas build --platform ios --profile production
```

Build profiles:
- `development`: Development builds with Expo Dev Client
- `preview`: APK/IPA for direct installation and testing
- `production`: App bundles/IPAs optimized for store submission

## 🛠️ Development

### Code Quality

```bash
# Lint TypeScript code (fails if warnings exceed the committed baseline)
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Regenerate the lint baseline after clearing warnings
# (then lower --max-warnings in package.json to match — see CONTRIBUTING.md)
npm run lint:baseline

# Format code with Prettier
npm run format

# Type check
npm run typecheck
```

### Project Structure

```
voi-wallet/
├── src/
│   ├── components/     # Reusable UI components
│   ├── screens/        # Screen components
│   ├── navigation/     # Navigation configuration
│   ├── services/       # Business logic and API integrations
│   ├── store/          # Zustand state management
│   ├── contexts/       # React contexts
│   ├── hooks/          # Custom React hooks
│   ├── utils/          # Utility functions
│   ├── types/          # TypeScript type definitions
│   └── config/         # App configuration
├── assets/             # Images, fonts, and other static assets
├── App.tsx             # Application entry point
└── app.config.js       # Expo configuration
```

## 🔒 Security

- Private keys are stored using Expo SecureStore
- PIN authentication with a hardware-backed 6-digit code stored via SecureStore
- Optional biometric authentication (Face ID/Touch ID/Fingerprint)
- Transaction signing requires authentication
- No private keys are ever transmitted

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Development Guidelines

- Follow TypeScript best practices
- Maintain 2-space indentation
- Run `npm run lint` and `npm run typecheck` before committing
- Use conventional commit messages (feat, fix, chore, etc.)
- Keep PRs focused and under 300 LOC when possible

## 📚 Technology Stack

- **Framework**: React Native with Expo
- **Language**: TypeScript
- **State Management**: Zustand
- **Navigation**: React Navigation
- **Blockchain SDK**: algosdk
- **Hardware Wallet**: Ledger (@ledgerhq packages)
- **dApp Protocol**: WalletConnect v2
- **Styling**: React Native StyleSheet

## 🌐 Networks Supported

- **Voi Network**: Primary network (Mainnet)
- **Algorand**: Algorand Mainnet support

## 📖 Documentation

- [Gotcha Guide](GOTCHA.md) - Common pitfalls and best practices
- [Contributing Guidelines](CONTRIBUTING.md) - How to contribute to this project

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔗 Links

- [Voi Network](https://voi.network)
- [Algorand Developer Portal](https://developer.algorand.org)
- [Expo Documentation](https://docs.expo.dev)
- [WalletConnect](https://walletconnect.com)

## 💬 Support

For issues, questions, or contributions, please open an issue on GitHub.

---

Built with ❤️ for the Voi Network community
