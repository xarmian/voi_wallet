import React, { useState, useEffect } from 'react';
import { Text } from 'react-native';
import EnvoiService, { EnvoiNameInfo } from '@/services/envoi';
import { formatAddressSync, formatAddress } from '@/utils/address';

interface TransactionAddressDisplayProps {
  address: string;
  isOutgoing: boolean;
  style?: any;
  addressStyle?: any;
  nameStyle?: any;
  showDirection?: boolean;
}

export default function TransactionAddressDisplay({
  address,
  isOutgoing,
  style,
  addressStyle,
  nameStyle,
  showDirection = true,
}: TransactionAddressDisplayProps) {
  const [nameInfo, setNameInfo] = useState<EnvoiNameInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let mounted = true;

    const loadName = async () => {
      if (!address) return;

      try {
        setIsLoading(true);
        const envoiService = EnvoiService.getInstance();
        const result = await envoiService.getName(address);

        if (mounted) {
          setNameInfo(result);
        }
      } catch (error) {
        console.warn('Failed to load Envoi name:', error);
        if (mounted) {
          setNameInfo(null);
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    loadName();

    return () => {
      mounted = false;
    };
  }, [address]);

  const getFormattedAddress = () => {
    return formatAddressSync(address, nameInfo, {
      prefixLength: 6,
      suffixLength: 4,
    });
  };

  const formatted = getFormattedAddress();
  const direction = showDirection ? (isOutgoing ? 'To: ' : 'From: ') : '';

  return (
    <Text style={style}>
      {direction}
      {nameInfo?.name ? (
        <>
          <Text style={nameStyle}>{nameInfo.name}</Text>
          {addressStyle && (
            <Text style={addressStyle}> ({formatAddress(address)})</Text>
          )}
        </>
      ) : (
        <Text style={addressStyle}>{formatted.displayText}</Text>
      )}
    </Text>
  );
}
