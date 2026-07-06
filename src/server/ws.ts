// ws.ts — the WebSocket layer: subscriptions, snapshot-on-subscribe, fan-out.
// Why: matches api-contract.md exactly — channels `book:SYM` / `trades:SYM` /
// `user`, JSON frames, snapshot then strictly-sequenced deltas.
// Key tradeoffs:
// - Slow consumers are disconnected, not buffered forever: if a socket's
//   kernel/user-space buffer exceeds a cap, we terminate it. The client
//   reconnects and gets a fresh snapshot — bounded memory beats unbounded
//   queues (the contract tells clients to expect this).
// - Snapshot consistency is free: the exchange is single-threaded, so a
//   snapshot taken between events plus subsequent deltas can never tear.

import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';
import type { Exchange } from './exchange.js';

const MAX_BUFFERED_BYTES = 1_000_000;
const IDLE_TIMEOUT_MS = 90_000; // contract asks clients to ping every ≤30s
const BOOK_DEPTH = 50;

interface Client {
  ws: WebSocket;
  userId: number | null;
  channels: Set<string>;
  lastSeen: number;
}

export class WsServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  /** channel → subscribed clients (books/trades); user events use userIndex. */
  private readonly byChannel = new Map<string, Set<Client>>();
  private readonly byUser = new Map<number, Set<Client>>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    server: Server,
    private readonly exchange: Exchange,
    jwtSecret: string,
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req, jwtSecret));

    // Register as the exchange's fan-out sink.
    exchange.events = {
      bookDelta: (symbol, msg) => this.broadcast(`book:${symbol}`, msg),
      trade: (symbol, msg) => this.broadcast(`trades:${symbol}`, msg),
      user: (userId, msg) => {
        const set = this.byUser.get(userId);
        if (set) for (const c of set) this.send(c, msg);
      },
    };

    this.sweeper = setInterval(() => this.sweepIdle(), 30_000);
    this.sweeper.unref();
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const c of this.clients) c.ws.terminate();
    this.wss.close();
  }

  private onConnection(ws: WebSocket, req: IncomingMessage, jwtSecret: string): void {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    const token = url.searchParams.get('token');
    const userId = token ? verifyToken(token, jwtSecret) : null;
    const client: Client = { ws, userId, channels: new Set(), lastSeen: Date.now() };
    this.clients.add(client);

    this.send(client, { type: 'hello', authenticated: userId !== null });

    ws.on('message', (data) => {
      client.lastSeen = Date.now();
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        this.send(client, { type: 'error', code: 'VALIDATION', message: 'frames must be JSON' });
        return;
      }
      this.onMessage(client, msg as Record<string, unknown>);
    });

    ws.on('close', () => this.removeClient(client));
    ws.on('error', () => ws.terminate());
  }

  private onMessage(client: Client, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ping':
        this.send(client, { type: 'pong' });
        return;
      case 'subscribe':
        this.subscribe(client, msg.channel);
        return;
      case 'unsubscribe':
        if (typeof msg.channel === 'string') this.dropChannel(client, msg.channel);
        return;
      default:
        this.send(client, { type: 'error', code: 'VALIDATION', message: 'unknown message type' });
    }
  }

  private subscribe(client: Client, channel: unknown): void {
    if (typeof channel !== 'string') {
      this.send(client, { type: 'error', code: 'VALIDATION', message: 'channel must be a string' });
      return;
    }
    if (channel === 'user') {
      if (client.userId === null) {
        this.send(client, { type: 'error', code: 'UNAUTHORIZED', message: 'user channel requires a token' });
        return;
      }
      let set = this.byUser.get(client.userId);
      if (!set) this.byUser.set(client.userId, (set = new Set()));
      set.add(client);
      client.channels.add('user');
      this.send(client, { type: 'subscribed', channel });
      return;
    }

    const [kind, symbol] = channel.split(':');
    if ((kind !== 'book' && kind !== 'trades') || !symbol || !this.exchange.meta(symbol)) {
      this.send(client, { type: 'error', code: 'UNKNOWN_CHANNEL', message: `unknown channel ${channel}` });
      return;
    }
    let set = this.byChannel.get(channel);
    if (!set) this.byChannel.set(channel, (set = new Set()));
    set.add(client);
    client.channels.add(channel);
    this.send(client, { type: 'subscribed', channel });

    if (kind === 'book') {
      const snap = this.exchange.bookSnapshot(symbol, BOOK_DEPTH);
      this.send(client, { type: 'book_snapshot', symbol, ...snap });
    }
  }

  private dropChannel(client: Client, channel: string): void {
    client.channels.delete(channel);
    if (channel === 'user' && client.userId !== null) {
      const set = this.byUser.get(client.userId);
      set?.delete(client);
      if (set?.size === 0) this.byUser.delete(client.userId);
      return;
    }
    const set = this.byChannel.get(channel);
    set?.delete(client);
    if (set?.size === 0) this.byChannel.delete(channel);
  }

  private removeClient(client: Client): void {
    for (const ch of client.channels) this.dropChannel(client, ch);
    this.clients.delete(client);
  }

  private broadcast(channel: string, msg: object): void {
    const set = this.byChannel.get(channel);
    if (!set || set.size === 0) return;
    const frame = JSON.stringify(msg);
    for (const c of set) this.sendRaw(c, frame);
  }

  private send(client: Client, msg: object): void {
    this.sendRaw(client, JSON.stringify(msg));
  }

  private sendRaw(client: Client, frame: string): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Slow consumer: dropping frames silently would corrupt its book state
      // (seq gap it can't see). Disconnecting is honest — the contract tells
      // clients to reconnect and resnapshot.
      client.ws.terminate();
      this.removeClient(client);
      return;
    }
    client.ws.send(frame);
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const c of this.clients) {
      if (c.lastSeen < cutoff) {
        c.ws.terminate();
        this.removeClient(c);
      }
    }
  }
}
