import type { FrostApi } from '../protocol.js';

declare global {
  interface Window {
    frost: FrostApi;
  }
}

export {};
