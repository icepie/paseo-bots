import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Minimal client for Tencent's iLink bot API (the WeChat "claw bot"
 * protocol): QR login, long-polled updates, text and media (image/file).
 * Media bytes travel through WeChat's CDN, AES-128-ECB encrypted both ways.
 * Endpoint shapes follow the public protocol (ilink/bot/*), see
 * shared/channels.ts for how accounts are stored.
 */

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";

/** WeChat's CDN: media up- and downloads, separate from the bot API host. */
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

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

/** Media that arrived with a message; bytes sit encrypted on WeChat's CDN. */
export interface InboundMedia {
  kind: "image" | "file";
  /** Original file name (files only; images get named on save). */
  name: string | null;
  /** CDN download reference. */
  cdnParam: string;
  /** AES key as hex (images carry it on the item; preferred). */
  aesKeyHex: string | null;
  /** AES key as base64 — of raw 16 bytes, or of their hex string. */
  aesKeyBase64: string | null;
}

export interface InboundMessage {
  messageId: number | null;
  fromUserId: string;
  groupId: string | null;
  /** Text body (voice messages use their speech-to-text). */
  text: string;
  /** Echoed verbatim when replying to this user. */
  contextToken: string | null;
  media: InboundMedia | null;
  /** Message types we don't read yet (video, referrals) arrived. */
  unsupported: boolean;
}

/** An uploaded file's coordinates, ready for a sendmessage media item. */
export interface UploadedMedia {
  /** CDN download reference (CDNMedia.encrypt_query_param). */
  downloadParam: string;
  /** AES key, base64 of its hex string — the shape CDNMedia.aes_key expects. */
  aesKeyBase64: string;
  /** Plaintext size. */
  rawSize: number;
  /** Ciphertext size (AES-128-ECB + PKCS7). */
  cipherSize: number;
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

/**
 * The media's AES-128 key. Images carry it hex-encoded on the item; the CDN
 * reference carries it base64-encoded — of the raw 16 bytes, or of their hex
 * string (files), which decodes to 32 ASCII hex chars.
 */
function aesKeyOf(media: InboundMedia): Buffer {
  if (media.aesKeyHex) return Buffer.from(media.aesKeyHex, "hex");
  const decoded = Buffer.from(media.aesKeyBase64 ?? "", "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
  throw new ILinkError(`CDN media aes_key must be 16 raw bytes or 32 hex chars, got ${decoded.length} bytes`, null);
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
    const data = (await response.json()) as { ret?: number; errcode?: number; errmsg?: string } & T;
    if (data.ret && data.ret !== 0) throw new ILinkError(`iLink ${path}: ${data.errmsg ?? `ret ${data.ret}`}`, data.errcode ?? data.ret);
    return data;
  }

  /** Step 1 of login: the QR code to show. Unauthenticated. */
  async getQRCode(): Promise<QRCode> {
    const data = await this.get<{ qrcode: string; qrcode_img_content: string }>("ilink/bot/get_bot_qrcode?bot_type=3", API_TIMEOUT_MS);
    return { qrcode: data.qrcode, qrUrl: data.qrcode_img_content };
  }

  /** Step 2 of login: long-poll the scan state until "confirmed"/"expired". */
  async pollQRCodeStatus(qrcode: string): Promise<QRStatus> {
    const data = await this.get<{ status: QRStatus["status"]; bot_token?: string; ilink_bot_id?: string; baseurl?: string; ilink_user_id?: string }>(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, LONG_POLL_FALLBACK_MS + 5_000);
    // The wire format is snake_case; QRStatus is the plugin's camelCase shape.
    return { status: data.status, botToken: data.bot_token, ilinkBotId: data.ilink_bot_id, baseUrl: data.baseurl, ilinkUserId: data.ilink_user_id };
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
        item_list?: Array<{
          type?: number;
          text_item?: { text?: string };
          voice_item?: { text?: string };
          image_item?: { media?: { encrypt_query_param?: string; aes_key?: string }; aeskey?: string };
          file_item?: { media?: { encrypt_query_param?: string; aes_key?: string }; file_name?: string };
        }>;
      }>;
      get_updates_buf?: string;
      longpolling_timeout_ms?: number;
    }>("ilink/bot/getupdates", { get_updates_buf: syncBuf, base_info: { channel_version: "paseo-bots" } }, LONG_POLL_FALLBACK_MS + 10_000);
    const messages: InboundMessage[] = [];
    for (const msg of data.msgs ?? []) {
      // 1 = from a user; 2 = our own bot's (skip, and skip anything without a sender).
      if (msg.message_type !== 1 || !msg.from_user_id) continue;
      let text = "";
      let media: InboundMedia | null = null;
      let unsupported = false;
      for (const item of msg.item_list ?? []) {
        if (item.type === 1 && item.text_item?.text != null) text = item.text_item.text;
        else if (item.type === 3 && item.voice_item?.text) text = item.voice_item.text;
        else if (item.type === 2 && item.image_item?.media?.encrypt_query_param) {
          media = { kind: "image", name: null, cdnParam: item.image_item.media.encrypt_query_param, aesKeyHex: item.image_item.aeskey ?? null, aesKeyBase64: item.image_item.media.aes_key ?? null };
        } else if (item.type === 4 && item.file_item?.media?.encrypt_query_param) {
          media = { kind: "file", name: item.file_item.file_name ?? null, cdnParam: item.file_item.media.encrypt_query_param, aesKeyHex: null, aesKeyBase64: item.file_item.media.aes_key ?? null };
        } else if (item.type === 2 || item.type === 4 || item.type === 5) unsupported = true;
      }
      // Media without its key can never be decrypted — treat it as unreadable.
      if (media && !media.aesKeyHex && !media.aesKeyBase64) {
        media = null;
        unsupported = true;
      }
      messages.push({
        messageId: msg.message_id ?? null,
        fromUserId: msg.from_user_id,
        groupId: msg.group_id ?? null,
        text,
        contextToken: msg.context_token ?? null,
        media,
        unsupported,
      });
    }
    return { messages, syncBuf: data.get_updates_buf ?? syncBuf, nextTimeoutMs: data.longpolling_timeout_ms ?? null };
  }

  /** Upload step 1: trade the file's coordinates for a CDN upload URL. */
  private async getUploadUrl(toUserId: string, kind: InboundMedia["kind"], filekey: string, rawSize: number, rawMd5: string, cipherSize: number, aesKeyHex: string): Promise<string> {
    const data = await this.post<{ upload_param?: string; upload_full_url?: string }>("ilink/bot/getuploadurl", {
      filekey,
      media_type: kind === "image" ? 1 : 3,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: cipherSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: { channel_version: "paseo-bots" },
    }, API_TIMEOUT_MS);
    // Servers answer either the ready-made URL or the param to build it from.
    if (data.upload_full_url) return data.upload_full_url;
    if (data.upload_param) return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(data.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
    throw new ILinkError(`iLink getuploadurl gave no upload URL: ${JSON.stringify(data).slice(0, 200)}`, null);
  }

  /** Upload a file's bytes (encrypted) to the CDN; the result goes into sendMedia. */
  async uploadMedia(kind: InboundMedia["kind"], toUserId: string, plaintext: Buffer): Promise<UploadedMedia> {
    const rawSize = plaintext.length;
    const rawMd5 = createHash("md5").update(plaintext).digest("hex");
    const cipherSize = Math.ceil((rawSize + 1) / 16) * 16;
    const filekey = randomBytes(16).toString("hex");
    const aesKey = randomBytes(16);
    const uploadUrl = await this.getUploadUrl(toUserId, kind, filekey, rawSize, rawMd5, cipherSize, aesKey.toString("hex"));
    const cipher = createCipheriv("aes-128-ecb", aesKey, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const response = await this.fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
      signal: timeoutSignal(API_TIMEOUT_MS * 4),
    });
    if (!response.ok) throw new ILinkError(`CDN upload: HTTP ${response.status}`, null);
    const downloadParam = response.headers.get("x-encrypted-param");
    if (!downloadParam) throw new ILinkError("CDN upload: no x-encrypted-param in the response", null);
    // CDNMedia.aes_key wants base64 of the key's hex string (not of the raw key).
    return { downloadParam, aesKeyBase64: Buffer.from(aesKey.toString("hex"), "utf-8").toString("base64"), rawSize, cipherSize };
  }

  /** Download and decrypt media that arrived with a message. */
  async downloadMedia(media: InboundMedia): Promise<Buffer> {
    const response = await this.fetchImpl(`${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.cdnParam)}`, { signal: timeoutSignal(API_TIMEOUT_MS * 4) });
    if (!response.ok) throw new ILinkError(`CDN download: HTTP ${response.status}`, null);
    const ciphertext = Buffer.from(await response.arrayBuffer());
    const decipher = createDecipheriv("aes-128-ecb", aesKeyOf(media), null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** A media message: one image or file item, context token echoed. */
  async sendMedia(toUserId: string, contextToken: string | null, kind: InboundMedia["kind"], name: string, uploaded: UploadedMedia): Promise<void> {
    const media = { encrypt_query_param: uploaded.downloadParam, aes_key: uploaded.aesKeyBase64, encrypt_type: 1 };
    await this.post("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken ?? undefined,
        item_list: [kind === "image" ? { type: 2, image_item: { media, mid_size: uploaded.cipherSize } } : { type: 4, file_item: { media, file_name: name, len: String(uploaded.rawSize) } }],
      },
      base_info: { channel_version: "paseo-bots" },
    }, API_TIMEOUT_MS);
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
