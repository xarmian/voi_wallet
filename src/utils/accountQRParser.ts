import algosdk from 'algosdk';
import { MultiAccountWalletService } from '@/services/wallet';
import {
  parseArc0300AccountImportUri,
  isArc0300AccountImportUri,
  normalizeBase64ToHex,
} from '@/utils/arc0300';

export interface AccountSecret {
  mnemonic?: string;
  privateKey?: string;
}

const accountSecretStore = new Map<string, AccountSecret>();

const generateSecretId = (): string =>
  `account_secret_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const storeAccountSecret = (secret: AccountSecret): string => {
  const id = generateSecretId();
  accountSecretStore.set(id, { ...secret });
  return id;
};

const scrubString = (value?: string): string | undefined => {
  if (!value) return undefined;
  return ''.padEnd(value.length, '0');
};

export const getAccountSecret = (
  id: string
): AccountSecret | undefined => {
  const secret = accountSecretStore.get(id);
  if (!secret) return undefined;
  return { ...secret };
};

export const clearAccountSecret = (id: string | undefined): void => {
  if (!id) return;
  const secret = accountSecretStore.get(id);
  if (secret) {
    secret.mnemonic = scrubString(secret.mnemonic);
    secret.privateKey = scrubString(secret.privateKey);
  }
  accountSecretStore.delete(id);
};

export const clearAccountSecrets = (ids: Array<string | undefined>): void => {
  ids.forEach((entry) => clearAccountSecret(entry));
};

export const clearAllAccountSecrets = (): void => {
  for (const id of Array.from(accountSecretStore.keys())) {
    clearAccountSecret(id);
  }
};

export interface ScannedAccount {
  id: string;
  type: 'standard' | 'watch';
  address: string;
  name?: string;
  secretId?: string;
  isValid: boolean;
  errorMessage?: string;
  isDuplicate?: boolean;
  isUpgrade?: boolean; // True when upgrading a watch account to a full account
  existingAccountId?: string; // ID of the existing account being upgraded
}

export interface QRAccountData {
  type:
    | 'voi-accounts'
    | 'single-mnemonic'
    | 'single-private-key'
    | 'address-list';
  accounts?: Array<{
    address?: string;
    name?: string;
    mnemonic?: string;
    privateKey?: string;
  }>;
  mnemonic?: string;
  privateKey?: string;
  addresses?: string[];
}

export interface ParsedQRResult {
  isAccountData: boolean;
  data?: QRAccountData;
  accounts: ScannedAccount[];
  errorMessage?: string;
}

export class AccountQRParser {
  private static generateAccountId(): string {
    return `scanned_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  static async parseQRContent(
    content: string,
    existingAccounts: any[] = []
  ): Promise<ParsedQRResult> {
    try {
      // First, try to parse as ARC-0300 (standardized format)
      const arc0300Result = await this.parseARC0300Format(
        content,
        existingAccounts
      );
      if (arc0300Result.isAccountData) {
        return arc0300Result;
      }

      // Try to parse as JSON
      const jsonResult = await this.parseJSONFormat(content, existingAccounts);
      if (jsonResult.isAccountData) {
        return jsonResult;
      }

      // Try as single mnemonic
      const mnemonicResult = await this.parseMnemonicFormat(
        content,
        existingAccounts
      );
      if (mnemonicResult.isAccountData) {
        return mnemonicResult;
      }

      // Try as single private key
      const privateKeyResult = await this.parsePrivateKeyFormat(
        content,
        existingAccounts
      );
      if (privateKeyResult.isAccountData) {
        return privateKeyResult;
      }

      // Try as address list
      const addressResult = await this.parseAddressListFormat(
        content,
        existingAccounts
      );
      if (addressResult.isAccountData) {
        return addressResult;
      }

      // Not account data
      return {
        isAccountData: false,
        accounts: [],
        errorMessage: 'QR code does not contain valid account data',
      };
    } catch (error) {
      return {
        isAccountData: false,
        accounts: [],
        errorMessage:
          error instanceof Error ? error.message : 'Failed to parse QR content',
      };
    }
  }

  private static async parseARC0300Format(
    content: string,
    existingAccounts: any[]
  ): Promise<ParsedQRResult> {
    try {
      if (!isArc0300AccountImportUri(content)) {
        return {
          isAccountData: false,
          accounts: [],
        };
      }

      const parsed = parseArc0300AccountImportUri(content);
      if (!parsed) {
        return {
          isAccountData: false,
          accounts: [],
        };
      }

      const accounts: ScannedAccount[] = [];

      for (const entry of parsed.entries) {
        try {
          let account: ScannedAccount;

          if (parsed.kind === 'standard' && entry.privateKeyBase64) {
            // Handle standard account with private key
            const privateKeyHex = normalizeBase64ToHex(entry.privateKeyBase64);
            const accountData = await this.processAccountData(
              {
                privateKey: privateKeyHex,
                name: entry.name,
              },
              existingAccounts
            );
            account = accountData;
          } else if (parsed.kind === 'watch' && entry.address) {
            // Handle watch account
            const accountData = await this.processAccountData(
              {
                address: entry.address,
                name: entry.name,
              },
              existingAccounts
            );
            account = accountData;
          } else {
            // Invalid entry
            continue;
          }

          accounts.push(account);
        } catch (error) {
          console.error('Failed to process ARC-0300 entry:', error);
          // Add invalid account entry for debugging
          accounts.push({
            id: this.generateAccountId(),
            type: parsed.kind,
            address: entry.address || '',
            name: entry.name || 'Invalid Entry',
            isValid: false,
            errorMessage:
              error instanceof Error
                ? error.message
                : 'Failed to process entry',
            isDuplicate: false,
          });
        }
      }

      return {
        isAccountData: true,
        data: {
          type: 'voi-accounts',
          accounts: parsed.entries.map((entry) => ({
            address: entry.address,
            name: entry.name,
          })),
        },
        accounts,
      };
    } catch (error) {
      return {
        isAccountData: false,
        accounts: [],
        errorMessage:
          error instanceof Error
            ? error.message
            : 'Failed to parse ARC-0300 URI',
      };
    }
  }

  private static async parseJSONFormat(
    content: string,
    existingAccounts: any[]
  ): Promise<ParsedQRResult> {
    try {
      const data = JSON.parse(content) as QRAccountData;

      if (data.type === 'voi-accounts' && data.accounts) {
        const accounts: ScannedAccount[] = [];

        for (const accountData of data.accounts) {
          const account = await this.processAccountData(
            accountData,
            existingAccounts
          );
          accounts.push(account);
        }

        const sanitizedData: QRAccountData = {
          type: 'voi-accounts',
          accounts: data.accounts.map((entry) => ({
            address: entry.address,
            name: entry.name,
          })),
        };

        return {
          isAccountData: true,
          data: sanitizedData,
          accounts,
        };
      }

      return {
        isAccountData: false,
        accounts: [],
      };
    } catch {
      return {
        isAccountData: false,
        accounts: [],
      };
    }
  }

  private static async parseMnemonicFormat(
    content: string,
    existingAccounts: any[]
  ): Promise<ParsedQRResult> {
    const trimmed = content.trim();
    const words = trimmed.split(/\s+/);

    if (
      words.length === 25 &&
      MultiAccountWalletService.validateMnemonic(trimmed)
    ) {
      const account = await this.processAccountData(
        { mnemonic: trimmed },
        existingAccounts
      );

      return {
        isAccountData: true,
        data: {
          type: 'single-mnemonic',
        },
        accounts: [account],
      };
    }

    return {
      isAccountData: false,
      accounts: [],
    };
  }

  private static async parsePrivateKeyFormat(
    content: string,
    existingAccounts: any[]
  ): Promise<ParsedQRResult> {
    const trimmed = content.trim().replace(/^0x/i, '');

    if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
      try {
        const account = await this.processAccountData(
          { privateKey: trimmed },
          existingAccounts
        );

        return {
          isAccountData: true,
          data: {
            type: 'single-private-key',
          },
          accounts: [account],
        };
      } catch {
        return {
          isAccountData: false,
          accounts: [],
        };
      }
    }

    return {
      isAccountData: false,
      accounts: [],
    };
  }

  private static async parseAddressListFormat(
    content: string,
    existingAccounts: any[]
  ): Promise<ParsedQRResult> {
    const lines = content
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (
      lines.length > 0 &&
      lines.every((line) => MultiAccountWalletService.validateAddress(line))
    ) {
      const accounts: ScannedAccount[] = [];

      for (const address of lines) {
        const account = await this.processAccountData(
          { address },
          existingAccounts
        );
        accounts.push(account);
      }

      return {
        isAccountData: true,
        data: {
          type: 'address-list',
          addresses: lines,
        },
        accounts,
      };
    }

    return {
      isAccountData: false,
      accounts: [],
    };
  }

  private static async processAccountData(
    accountData: {
      address?: string;
      name?: string;
      mnemonic?: string;
      privateKey?: string;
    },
    existingAccounts: any[]
  ): Promise<ScannedAccount> {
    const id = this.generateAccountId();
    let address = accountData.address;
    let type: 'standard' | 'watch' = 'watch';
    let isValid = false;
    let errorMessage: string | undefined;
    let secretId: string | undefined;

    const sanitizedMnemonic = accountData.mnemonic?.trim();
    const sanitizedPrivateKey = accountData.privateKey
      ? accountData.privateKey.trim().replace(/^0x/i, '')
      : undefined;

    try {
      if (sanitizedMnemonic) {
        if (MultiAccountWalletService.validateMnemonic(sanitizedMnemonic)) {
          const walletAccount = MultiAccountWalletService.importFromMnemonic(
            sanitizedMnemonic
          );
          address = walletAccount.address;
          type = 'standard';
          isValid = true;
        } else {
          errorMessage = 'Invalid mnemonic phrase';
        }
      } else if (sanitizedPrivateKey) {
        try {
          const walletAccount = MultiAccountWalletService.importFromPrivateKey(
            sanitizedPrivateKey
          );
          address = walletAccount.address;
          type = 'standard';
          isValid = true;
        } catch (error) {
          errorMessage = 'Invalid private key';
        }
      } else if (accountData.address) {
        if (MultiAccountWalletService.validateAddress(accountData.address)) {
          address = accountData.address;
          type = 'watch';
          isValid = true;
        } else {
          errorMessage = 'Invalid address';
        }
      } else {
        errorMessage = 'No valid account data provided';
      }

      // Check for existing account with same address
      const existingAccount = address
        ? existingAccounts.find((acc) => acc.address === address)
        : undefined;

      // Determine if this is a duplicate or an upgrade scenario
      let isDuplicate = false;
      let isUpgrade = false;
      let existingAccountId: string | undefined;

      if (existingAccount) {
        // Check if this is an upgrade from watch to standard
        const isStandardImport = type === 'standard';
        const existingIsWatch = existingAccount.type === 'watch';

        if (isStandardImport && existingIsWatch) {
          // This is an upgrade scenario - allow importing the private key
          isUpgrade = true;
          existingAccountId = existingAccount.id;
        } else {
          // True duplicate - same type or downgrade (standard exists, importing watch)
          isDuplicate = true;
        }
      }

      // Store secret for valid accounts that are not true duplicates
      if (isValid && !isDuplicate && (sanitizedMnemonic || sanitizedPrivateKey)) {
        secretId = storeAccountSecret({
          mnemonic: sanitizedMnemonic,
          privateKey: sanitizedPrivateKey,
        });
      }

      return {
        id,
        type,
        address: address || '',
        name: accountData.name || this.generateDefaultName(type, address),
        secretId,
        isValid,
        errorMessage,
        isDuplicate,
        isUpgrade,
        existingAccountId,
      };
    } catch (error) {
      return {
        id,
        type: 'watch',
        address: address || '',
        name: accountData.name || 'Invalid Account',
        secretId,
        isValid: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        isDuplicate: false,
      };
    }
  }

  private static generateDefaultName(
    type: 'standard' | 'watch',
    address?: string
  ): string {
    const timestamp = new Date().toLocaleDateString();
    if (type === 'watch') {
      return `Watch Account ${timestamp}`;
    } else {
      return `Imported Account ${timestamp}`;
    }
  }

  static isPaymentQR(content: string): boolean {
    const lower = content.toLowerCase();
    return (
      lower.startsWith('algorand://') ||
      lower.startsWith('voi://') ||
      lower.startsWith('perawallet://')
    );
  }

  static isWalletConnectQR(content: string): boolean {
    return content.startsWith('wc:');
  }

  static shouldHandleAsAccountImport(content: string): boolean {
    // Quick check to avoid expensive parsing for obviously non-account QRs
    if (this.isPaymentQR(content) || this.isWalletConnectQR(content)) {
      return false;
    }

    // Check for ARC-0300 format first (standard)
    if (isArc0300AccountImportUri(content)) {
      return true;
    }

    // Check for potential account data patterns
    if (
      content.includes('"type":"voi-accounts"') ||
      content.includes('"accounts"') ||
      content.split(/\s+/).length === 25 ||
      /^[0-9a-fA-F]{128}$/.test(content.trim().replace(/^0x/i, '')) ||
      content
        .split('\n')
        .every(
          (line) =>
            line.trim().length === 58 && line.trim().match(/^[A-Z0-9]+$/)
        )
    ) {
      return true;
    }

    return false;
  }
}
