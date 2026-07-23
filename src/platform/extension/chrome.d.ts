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

    function sendMessage(
      message: any,
      callback?: (response: any) => void
    ): void;
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

// Make chrome available globally.
// eslint-disable-next-line no-var, @typescript-eslint/no-redeclare -- ambient global: `declare var` is the correct idiom for a runtime-provided global (as in lib.dom.d.ts); let/const would change the declaration semantics. no-redeclare fires because this `var` merges with the `declare namespace chrome` at :6 — a legal TS var+namespace merge that the rule's `ignoreDeclarationMerge` option does NOT whitelist (it covers interface/namespace/class/function/enum, not var). Not a bug: `tsc --noEmit --skipLibCheck` on this file exits 0. Suppress rather than delete the declaration.
declare var chrome: typeof chrome;
