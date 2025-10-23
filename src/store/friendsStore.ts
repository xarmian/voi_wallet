import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Friend,
  FriendTransaction,
  FriendAlreadyExistsError,
  FriendNotFoundError,
  InvalidEnvoiNameError,
  FriendStorageError,
} from '@/types/social';
import EnvoiService from '@/services/envoi';

const STORAGE_KEYS = {
  FRIENDS_LIST: '@friends/list',
  PROFILES_CACHE: '@friends/profiles_cache',
} as const;

const MAX_FRIENDS = 500;
const PROFILE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

interface FriendsState {
  // State
  friends: Friend[];
  isLoading: boolean;
  lastError: string | null;
  isInitialized: boolean;

  // Actions
  initialize: () => Promise<void>;
  addFriend: (envoiName: string) => Promise<Friend>;
  removeFriend: (envoiName: string) => Promise<void>;
  getFriend: (envoiName: string) => Friend | null;
  toggleFavorite: (envoiName: string) => Promise<void>;
  updateFriendNotes: (envoiName: string, notes: string) => Promise<void>;
  refreshFriendProfile: (envoiName: string) => Promise<void>;
  refreshAllProfiles: () => Promise<void>;
  searchFriends: (query: string) => Friend[];
  updateLastInteraction: (envoiName: string, timestamp: number) => Promise<void>;
  clearError: () => void;
}

export const useFriendsStore = create<FriendsState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    friends: [],
    isLoading: false,
    lastError: null,
    isInitialized: false,

    // Initialize store from AsyncStorage
    initialize: async () => {
      try {
        set({ isLoading: true, lastError: null });

        const friendsJson = await AsyncStorage.getItem(STORAGE_KEYS.FRIENDS_LIST);
        const friends = friendsJson ? JSON.parse(friendsJson) : [];

        set({ friends, isInitialized: true, isLoading: false });
      } catch (error) {
        console.error('Failed to initialize friends store:', error);
        set({
          lastError: 'Failed to load friends',
          isLoading: false,
          isInitialized: true,
        });
      }
    },

    // Add a new friend by Envoi name
    addFriend: async (envoiName: string) => {
      const { friends } = get();

      // Validate not already a friend
      if (friends.some(f => f.envoiName.toLowerCase() === envoiName.toLowerCase())) {
        throw new FriendAlreadyExistsError(envoiName);
      }

      // Check friend limit
      if (friends.length >= MAX_FRIENDS) {
        throw new FriendStorageError(`Maximum number of friends (${MAX_FRIENDS}) reached`);
      }

      set({ isLoading: true, lastError: null });

      try {
        // Resolve Envoi name to get profile
        const envoiService = EnvoiService.getInstance();
        const wasEnabled = envoiService.isServiceEnabled();
        envoiService.setEnabled(true);

        const profile = await envoiService.getAddress(envoiName);

        envoiService.setEnabled(wasEnabled);

        if (!profile) {
          throw new InvalidEnvoiNameError(envoiName);
        }

        // Create friend object
        const newFriend: Friend = {
          id: `friend_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          envoiName: profile.name || envoiName,
          address: profile.address,
          avatar: profile.avatar,
          bio: profile.bio,
          socialLinks: profile.socialLinks,
          addedAt: Date.now(),
          isFavorite: false,
          profileLastUpdated: Date.now(),
        };

        const updatedFriends = [...friends, newFriend];

        // Save to AsyncStorage
        await AsyncStorage.setItem(
          STORAGE_KEYS.FRIENDS_LIST,
          JSON.stringify(updatedFriends)
        );

        set({ friends: updatedFriends, isLoading: false });

        return newFriend;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to add friend';
        set({ lastError: errorMessage, isLoading: false });
        throw error;
      }
    },

    // Remove a friend
    removeFriend: async (envoiName: string) => {
      const { friends } = get();

      const friendIndex = friends.findIndex(
        f => f.envoiName.toLowerCase() === envoiName.toLowerCase()
      );

      if (friendIndex === -1) {
        throw new FriendNotFoundError(envoiName);
      }

      set({ isLoading: true, lastError: null });

      try {
        const updatedFriends = friends.filter((_, index) => index !== friendIndex);

        await AsyncStorage.setItem(
          STORAGE_KEYS.FRIENDS_LIST,
          JSON.stringify(updatedFriends)
        );

        set({ friends: updatedFriends, isLoading: false });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to remove friend';
        set({ lastError: errorMessage, isLoading: false });
        throw new FriendStorageError(errorMessage);
      }
    },

    // Get a specific friend
    getFriend: (envoiName: string) => {
      const { friends } = get();
      return friends.find(
        f => f.envoiName.toLowerCase() === envoiName.toLowerCase()
      ) || null;
    },

    // Toggle favorite status
    toggleFavorite: async (envoiName: string) => {
      const { friends } = get();

      const friendIndex = friends.findIndex(
        f => f.envoiName.toLowerCase() === envoiName.toLowerCase()
      );

      if (friendIndex === -1) {
        throw new FriendNotFoundError(envoiName);
      }

      try {
        const updatedFriends = [...friends];
        updatedFriends[friendIndex] = {
          ...updatedFriends[friendIndex],
          isFavorite: !updatedFriends[friendIndex].isFavorite,
        };

        await AsyncStorage.setItem(
          STORAGE_KEYS.FRIENDS_LIST,
          JSON.stringify(updatedFriends)
        );

        set({ friends: updatedFriends });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to toggle favorite';
        set({ lastError: errorMessage });
        throw new FriendStorageError(errorMessage);
      }
    },

    // Update friend notes
    updateFriendNotes: async (envoiName: string, notes: string) => {
      const { friends } = get();

      const friendIndex = friends.findIndex(
        f => f.envoiName.toLowerCase() === envoiName.toLowerCase()
      );

      if (friendIndex === -1) {
        throw new FriendNotFoundError(envoiName);
      }

      try {
        const updatedFriends = [...friends];
        updatedFriends[friendIndex] = {
          ...updatedFriends[friendIndex],
          notes: notes.trim() || undefined,
        };

        await AsyncStorage.setItem(
          STORAGE_KEYS.FRIENDS_LIST,
          JSON.stringify(updatedFriends)
        );

        set({ friends: updatedFriends });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to update notes';
        set({ lastError: errorMessage });
        throw new FriendStorageError(errorMessage);
      }
    },

    // Refresh a specific friend's profile
    refreshFriendProfile: async (envoiName: string) => {
      const { friends } = get();

      const friendIndex = friends.findIndex(
        f => f.envoiName.toLowerCase() === envoiName.toLowerCase()
      );

      if (friendIndex === -1) {
        throw new FriendNotFoundError(envoiName);
      }

      try {
        const envoiService = EnvoiService.getInstance();
        const wasEnabled = envoiService.isServiceEnabled();
        envoiService.setEnabled(true);

        const profile = await envoiService.getAddress(envoiName);

        envoiService.setEnabled(wasEnabled);

        if (profile) {
          const updatedFriends = [...friends];
          updatedFriends[friendIndex] = {
            ...updatedFriends[friendIndex],
            address: profile.address,
            avatar: profile.avatar,
            bio: profile.bio,
            socialLinks: profile.socialLinks,
            profileLastUpdated: Date.now(),
          };

          await AsyncStorage.setItem(
            STORAGE_KEYS.FRIENDS_LIST,
            JSON.stringify(updatedFriends)
          );

          set({ friends: updatedFriends });
        }
      } catch (error) {
        console.error(`Failed to refresh profile for ${envoiName}:`, error);
        // Don't throw - profile refresh failures shouldn't be fatal
      }
    },

    // Refresh all friend profiles
    refreshAllProfiles: async () => {
      const { friends } = get();

      set({ isLoading: true });

      try {
        const envoiService = EnvoiService.getInstance();
        const wasEnabled = envoiService.isServiceEnabled();
        envoiService.setEnabled(true);

        const updatePromises = friends.map(async (friend) => {
          try {
            const profile = await envoiService.getAddress(friend.envoiName);
            if (profile) {
              return {
                ...friend,
                address: profile.address,
                avatar: profile.avatar,
                bio: profile.bio,
                socialLinks: profile.socialLinks,
                profileLastUpdated: Date.now(),
              };
            }
            return friend;
          } catch (error) {
            console.error(`Failed to refresh ${friend.envoiName}:`, error);
            return friend;
          }
        });

        const updatedFriends = await Promise.all(updatePromises);

        envoiService.setEnabled(wasEnabled);

        await AsyncStorage.setItem(
          STORAGE_KEYS.FRIENDS_LIST,
          JSON.stringify(updatedFriends)
        );

        set({ friends: updatedFriends, isLoading: false });
      } catch (error) {
        console.error('Failed to refresh all profiles:', error);
        set({ isLoading: false });
      }
    },

    // Search friends by name or bio
    searchFriends: (query: string) => {
      const { friends } = get();

      if (!query.trim()) {
        return friends;
      }

      const lowerQuery = query.toLowerCase();

      return friends.filter(friend =>
        friend.envoiName.toLowerCase().includes(lowerQuery) ||
        friend.bio?.toLowerCase().includes(lowerQuery) ||
        friend.notes?.toLowerCase().includes(lowerQuery)
      );
    },

    // Update last interaction timestamp
    updateLastInteraction: async (envoiName: string, timestamp: number) => {
      const { friends } = get();

      const friendIndex = friends.findIndex(
        f => f.envoiName.toLowerCase() === envoiName.toLowerCase()
      );

      if (friendIndex === -1) {
        return; // Silently fail - not all transactions are with friends
      }

      try {
        const updatedFriends = [...friends];
        updatedFriends[friendIndex] = {
          ...updatedFriends[friendIndex],
          lastInteraction: timestamp,
        };

        await AsyncStorage.setItem(
          STORAGE_KEYS.FRIENDS_LIST,
          JSON.stringify(updatedFriends)
        );

        set({ friends: updatedFriends });
      } catch (error) {
        console.error('Failed to update last interaction:', error);
        // Don't throw - this is a non-critical update
      }
    },

    // Clear error
    clearError: () => {
      set({ lastError: null });
    },
  }))
);

// Hook to get sorted friends (favorites first, then by name)
export const useSortedFriends = () => {
  const friends = useFriendsStore((state) => state.friends);

  return [...friends].sort((a, b) => {
    // Favorites first
    if (a.isFavorite !== b.isFavorite) {
      return a.isFavorite ? -1 : 1;
    }
    // Then alphabetically by Envoi name
    return a.envoiName.localeCompare(b.envoiName);
  });
};

// Hook to check if an address or Envoi name is a friend
export const useIsFriend = (addressOrName: string): boolean => {
  const friends = useFriendsStore((state) => state.friends);

  return friends.some(
    f => f.address === addressOrName ||
         f.envoiName.toLowerCase() === addressOrName.toLowerCase()
  );
};

// Hook to get friend by address or Envoi name
export const useFriendByAddressOrName = (addressOrName: string): Friend | null => {
  const friends = useFriendsStore((state) => state.friends);

  return friends.find(
    f => f.address === addressOrName ||
         f.envoiName.toLowerCase() === addressOrName.toLowerCase()
  ) || null;
};
