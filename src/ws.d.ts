declare module "ws" {
  import { EventEmitter } from "node:events";

  export default class WebSocket extends EventEmitter {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    readonly readyState: number;

    constructor(address: string, protocolsOrOptions?: string | string[] | Record<string, unknown>, options?: Record<string, unknown>);

    send(data: string | Buffer, callback?: (error?: Error) => void): void;
    ping(data?: string | Buffer): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
  }
}
