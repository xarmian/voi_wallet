/**
 * Chrome Extension API Type Declarations
 * Minimal declarations for the APIs used by the platform adapters
 */

declare namespace chrome {
  namespace storage {
    interface StorageChange {
      newValue?: any;
      oldValue?: any;
    }

    interface StorageArea {
      get(
        keys: string | string[] | null,
        callback: (items: { [key: string]: any }) => void
      ): void;
      set(items: { [key: string]: any }, callback?: () => void): void;
      remove(keys: string | string[], callback?: () => void): void;
    }

    const local: StorageArea;

    const onChanged: {
      addListener(
        callback: (
          changes: { [key: string]: StorageChange },
          areaName: string
        ) => void
      ): void;
      removeListener(
        callback: (
          changes: { [key: string]: StorageChange },
          areaName: string
        ) => void
      ): void;
    };
  }

  namespace runtime {
    const id: string | undefined;
    const lastError: { message?: string } | undefined;

    function sendMessage(message: any, callback?: (response: any) => void): void;
    function getURL(path: string): string;

    interface MessageSender {
      origin?: string;
      tab?: chrome.tabs.Tab;
    }

    interface MessageEvent {
      addListener(
        callback: (
          message: any,
          sender: MessageSender,
          sendResponse: (response?: any) => void
        ) => boolean | void
      ): void;
    }

    const onMessage: MessageEvent;

    const onMessageExternal: {
      addListener(
        callback: (
          message: any,
          sender: MessageSender,
          sendResponse: (response?: any) => void
        ) => boolean | void
      ): void;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
    }

    function create(createProperties: { url: string }): void;
  }

  namespace windows {
    interface Window {
      id?: number;
    }

    function create(createData: {
      url?: string;
      type?: 'normal' | 'popup' | 'panel';
      width?: number;
      height?: number;
      focused?: boolean;
    }): Promise<Window>;

    function get(windowId: number): Promise<Window>;

    function update(
      windowId: number,
      updateInfo: { focused?: boolean }
    ): Promise<Window>;

    const onRemoved: {
      addListener(callback: (windowId: number) => void): void;
    };
  }
}

// Make chrome available globally
declare var chrome: typeof chrome;
