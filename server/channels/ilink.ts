import { randomBytes, randomUUID } from "node:crypto";

/**
 * Minimal client for Tencent's iLink bot API (the WeChat "claw bot"
 * protocol): QR login, long-polled updates and plain text replies.
 * JSON over HTTP; no media yet. Endpoint shapes follow the public protocol
 * (ilink/bot/*), see shared/channels.ts for how accounts are stored.
 */

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";

/** Errors carrying the server's numeric code (-14 = session expired). */
export class ILinkError extends Error {
  constructor(
    message: string,
    readonly errcode: number | null,
  ) {
    super(message);
  }
}

export interface QRCode {
  qrcode: string;
  /** URL that renders the QR image. */
  qrUrl: string;
}

export interface QRStatus {
  status: "wait" | "scaned" | "confirmed" | "expired";
  botToken?: string;
  ilinkBotId?: string;
  baseUrl?: string;
  ilinkUserId?: string;
}

export interface InboundMessage {
  messageId: number | null;
  fromUserId: string;
  groupId: string | null;
  /** Text body (voice messages use their speech-to-text). */
  text: string;
  /** Echoed verbatim when replying to this user. */
  contextToken: string | null;
  /** Message types we don't read yet (image/file/video) arrived. */
  unsupported: boolean;
}

export interface Updates {
  messages: InboundMessage[];
  /** Cursor for the next poll; empty when nothing new. */
  syncBuf: string;
  /** Server-suggested next long-poll timeout. */
  nextTimeoutMs: number | null;
}

const API_TIMEOUT_MS = 15_000;
const LONG_POLL_FALLBACK_MS = 35_000;
const TEXT_CHUNK = 1_800;

/** Aborts after `ms` (this repo's TS lib predates AbortSignal.timeout). */
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref();
  return controller.signal;
}

/** X-WECHAT-UIN: random uint32 as decimal string, base64-encoded. */
function wechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}

type FetchLike = typeof fetch;

export class ILinkClient {
  constructor(
    readonly baseUrl: string = ILINK_BASE_URL,
    private token: string | null = null,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": wechatUin(),
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers,
      body: raw,
      signal: timeoutSignal(timeoutMs),
    });
    if (!response.ok) throw new ILinkError(`iLink ${path}: HTTP ${response.status}`, null);
    const data = (await response.json()) as { ret?: number; errcode?: number; errmsg?: string } & T;
    if (data.ret && data.ret !== 0) throw new ILinkError(`iLink ${path}: ${data.errmsg ?? `ret ${data.ret}`}`, data.errcode ?? data.ret);
    return data;
  }

  private async get<T>(path: string, timeoutMs: number): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, { signal: timeoutSignal(timeoutMs) });
    if (!response.ok) throw new ILinkError(`iLink ${path}: HTTP ${response.status}`, null);
    return (await response.json()) as T;
  }

  /** Step 1 of login: the QR code to show. Unauthenticated. */
  async getQRCode(): Promise<QRCode> {
    const data = await this.get<{ qrcode: string; qrcode_img_content: string }>("ilink/bot/get_bot_qrcode?bot_type=3", API_TIMEOUT_MS);
    return { qrcode: data.qrcode, qrUrl: data.qrcode_img_content };
  }

  /** Step 2 of login: long-poll the scan state until "confirmed"/"expired". */
  async pollQRCodeStatus(qrcode: string): Promise<QRStatus> {
    return this.get<QRStatus>(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, LONG_POLL_FALLBACK_MS + 5_000);
  }

  /** Long-poll for new direct messages. `syncBuf` is "" on first connect. */
  async getUpdates(syncBuf: string): Promise<Updates> {
    const data = await this.post<{
      msgs?: Array<{
        message_id?: number;
        from_user_id?: string;
        group_id?: string;
        message_type?: number;
        context_token?: string;
        item_list?: Array<{ type?: number; text_item?: { text?: string }; voice_item?: { text?: string } }>;
      }>;
      get_updates_buf?: string;
      longpolling_timeout_ms?: number;
    }>("ilink/bot/getupdates", { get_updates_buf: syncBuf, base_info: { channel_version: "paseo-bots" } }, LONG_POLL_FALLBACK_MS + 10_000);
    const messages: InboundMessage[] = [];
    for (const msg of data.msgs ?? []) {
      // 1 = from a user; 2 = our own bot's (skip, and skip anything without a sender).
      if (msg.message_type !== 1 || !msg.from_user_id) continue;
      let text = "";
      let unsupported = false;
      for (const item of msg.item_list ?? []) {
        if (item.type === 1 && item.text_item?.text != null) text = item.text_item.text;
        else if (item.type === 3 && item.voice_item?.text) text = item.voice_item.text;
        else if (item.type === 2 || item.type === 4 || item.type === 5) unsupported = true;
      }
      messages.push({
        messageId: msg.message_id ?? null,
        fromUserId: msg.from_user_id,
        groupId: msg.group_id ?? null,
        text,
        contextToken: msg.context_token ?? null,
        unsupported,
      });
    }
    return { messages, syncBuf: data.get_updates_buf ?? syncBuf, nextTimeoutMs: data.longpolling_timeout_ms ?? null };
  }

  /** Plain-text reply to one user, chunked to WeChat's message size. */
  async sendText(toUserId: string, contextToken: string | null, text: string): Promise<void> {
    for (let at = 0; at < Math.max(text.length, 1); at += TEXT_CHUNK) {
      await this.post("ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken ?? undefined,
          item_list: [{ type: 1, text_item: { text: text.slice(at, at + TEXT_CHUNK) } }],
        },
        base_info: { channel_version: "paseo-bots" },
      }, API_TIMEOUT_MS);
    }
  }
}
