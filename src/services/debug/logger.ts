interface LogEntry {
  timestamp: string;
  level: 'log' | 'warn' | 'error';
  message: string;
  data?: any;
}

class DebugLogger {
  private static instance: DebugLogger;
  private logs: LogEntry[] = [];
  private maxLogs = 100;
  private listeners: Set<(logs: LogEntry[]) => void> = new Set();

  static getInstance(): DebugLogger {
    if (!DebugLogger.instance) {
      DebugLogger.instance = new DebugLogger();
    }
    return DebugLogger.instance;
  }

  private constructor() {
    this.setupConsoleInterception();
  }

  private setupConsoleInterception() {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args: any[]) => {
      originalLog(...args);
      this.captureLog('log', args);
    };

    console.warn = (...args: any[]) => {
      originalWarn(...args);
      this.captureLog('warn', args);
    };

    console.error = (...args: any[]) => {
      originalError(...args);
      this.captureLog('error', args);
    };
  }

  private captureLog(level: 'log' | 'warn' | 'error', args: any[]) {
    const message = args.join(' ');

    // Only capture Ledger-related logs and important errors
    if (
      message.includes('Ledger') ||
      level === 'error' ||
      (level === 'warn' && message.includes('Ledger'))
    ) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        data: args.length > 1 ? args.slice(1) : undefined,
      };

      this.logs.push(entry);

      // Keep only the latest logs
      if (this.logs.length > this.maxLogs) {
        this.logs = this.logs.slice(-this.maxLogs);
      }

      // Notify listeners
      this.listeners.forEach(listener => {
        try {
          listener(this.logs);
        } catch (error) {
          // Don't let listener errors break logging
        }
      });
    }
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
    this.listeners.forEach(listener => {
      try {
        listener(this.logs);
      } catch (error) {
        // Don't let listener errors break logging
      }
    });
  }

  addListener(listener: (logs: LogEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Add a debug log entry manually
  addDebugEntry(message: string, data?: any): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'log',
      message: `[DEBUG] ${message}`,
      data,
    };

    this.logs.push(entry);

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    this.listeners.forEach(listener => {
      try {
        listener(this.logs);
      } catch (error) {
        // Don't let listener errors break logging
      }
    });
  }
}

export const debugLogger = DebugLogger.getInstance();
export type { LogEntry };