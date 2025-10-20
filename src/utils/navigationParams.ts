import { TransactionInfo } from '@/types/wallet';

type SerializableNumeric = string | number;

export type SerializableTransactionInfo = Omit<
  TransactionInfo,
  'amount' | 'fee' | 'confirmedRound'
> & {
  amount: SerializableNumeric;
  fee: SerializableNumeric;
  confirmedRound?: SerializableNumeric;
};

const serializeNumeric = (
  value: number | bigint | undefined
): SerializableNumeric | undefined => {
  if (typeof value === 'undefined') {
    return undefined;
  }

  return typeof value === 'bigint' ? value.toString() : value;
};

const deserializeNumeric = (
  value: SerializableNumeric | undefined
): number | bigint | undefined => {
  if (typeof value === 'undefined') {
    return undefined;
  }

  if (typeof value === 'number') {
    return value;
  }

  // Attempt to preserve precision by parsing to BigInt when possible
  if (/^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch (error) {
      console.warn(
        'Failed to parse BigInt from navigation param:',
        value,
        error
      );
    }
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const ensureNumeric = (value: SerializableNumeric): number | bigint => {
  const parsed = deserializeNumeric(value);
  if (typeof parsed === 'undefined') {
    console.warn(
      'Falling back to 0 for unparseable navigation numeric value:',
      value
    );
    return 0;
  }

  return parsed;
};

const ensureNumericSerializable = (
  value: number | bigint
): SerializableNumeric => {
  const serialized = serializeNumeric(value);
  if (typeof serialized === 'undefined') {
    console.warn('Falling back to "0" for missing navigation numeric value');
    return '0';
  }

  return serialized;
};

export const serializeTransactionForNavigation = (
  transaction: TransactionInfo
): SerializableTransactionInfo => ({
  ...transaction,
  amount: ensureNumericSerializable(transaction.amount),
  fee: ensureNumericSerializable(transaction.fee),
  confirmedRound: serializeNumeric(transaction.confirmedRound),
});

export const deserializeTransactionFromNavigation = (
  transaction: SerializableTransactionInfo
): TransactionInfo => ({
  ...transaction,
  amount: ensureNumeric(transaction.amount),
  fee: ensureNumeric(transaction.fee),
  confirmedRound: deserializeNumeric(transaction.confirmedRound),
});
