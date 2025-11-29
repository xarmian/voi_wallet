/**
 * Chrome Extension API Type Declarations
 * Minimal declarations for the APIs used by the platform adapters
 */

declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(
        keys: string | string[] | null,
        callback: (items: { [key: string]: any }) => void
      ): void;
      set(items: { [key: string]: any }, callback?: () => void): void;
      remove(keys: string | string[], callback?: () => void): void;
    }

    const local: StorageArea;
  }

  namespace runtime {
    const id: string | undefined;
    const lastError: { message?: string } | undefined;

    function sendMessage(message: any, callback?: (response: any) => void): void;

    interface MessageEvent {
      addListener(
        callback: (
          message: any,
          sender: any,
          sendResponse: (response?: any) => void
        ) => boolean | void
      ): void;
    }

    const onMessage: MessageEvent;
  }

  namespace tabs {
    function create(createProperties: { url: string }): void;
  }
}

// Make chrome available globally
declare var chrome: typeof chrome;
