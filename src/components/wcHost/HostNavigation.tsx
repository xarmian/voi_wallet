import React from 'react';
import { NavigationContext } from '@react-navigation/native';

// useFocusEffect and useLockFocus only read these two methods. This source
// belongs to the mounted body and has no router or synthetic focus events.
const navigation = {
  isFocused: () => true,
  addListener: () => () => {},
} as unknown as NonNullable<React.ContextType<typeof NavigationContext>>;

export default function HostNavigation({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <NavigationContext.Provider value={navigation}>
      {children}
    </NavigationContext.Provider>
  );
}
