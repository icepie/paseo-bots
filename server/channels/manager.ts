import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { foldText } from "../../shared/activity";
import { CHANNEL_ACCOUNT_LABEL, CHANNEL_FROM_LABEL, ChannelStoreSchema, EMPTY_CHANNEL_STORE, type ChannelAccount, type ChannelStore } from "../../shared/channels";
import { pluginDataPath } from "../bot-home";
import { startChat } from "../chats";
import type { BotsHost } from "../host";
import type { Relay } from "../relay";
import { ILINK_BASE_URL, ILinkClient, ILinkError, type InboundMessage } from "./ilink";

/**
 * Runs the IM channel accounts (WeChat over iLink): a long-poll monitor per
 * account maps each direct chat to one Paseo chat of the bound bot, and
 * turnEnded (server/activity) sends the chat's replies back. Credentials live
 * in channels.json (mode 0600); monitors start once the Paseo API is attached.
 */

const LOGIN_TIMEOUT_MS = 8 * 60_000;
const LOGIN_MAX_REFRESHES = 3;
const LOGIN_KEEP_MS = 15 * 60_000;
const RETRY_MS = 5_000;
/** iLink's session-expired errcode: the account needs a fresh QR login. */
const SESSION_EXPIRED = -14;

export interface ChannelAccountInfo {
  id: string;
  type: "wechat";
  ilinkBotId: string;
  ownerUserId: string | null;
  allowFrom: string[];
  running: boolean;
}

export type LoginStatus = "wait" | "scaned" | "confirmed" | "expired" | "error";

interface PendingLogin {
  botId: string;
  startedAt: number;
  client: ILinkClient;
  qrcode: string;
  qrUrl: string;
  status: LoginStatus;
  account: ChannelAccountInfo | null;
  error: string | null;
}

const storePath = () => join(pluginDataPath(), "channels.json");

function infoOf(account: ChannelAccount, running: boolean): ChannelAccountInfo {
  return { id: account.id, type: account.type, ilinkBotId: account.ilinkBotId, ownerUserId: account.ownerUserId, allowFrom: account.allowFrom, running };
}

/** A channel message becomes the chat's user message; strangers never reach the bot. */
function allows(account: ChannelAccount, fromUserId: string): boolean {
  if (fromUserId === account.ownerUserId || account.allowFrom.includes(fromUserId)) return true;
  // No owner recorded (older logins): the bot is open to whoever reaches it.
  return !account.ownerUserId && account.allowFrom.length === 0;
}

function frameInbound(account: ChannelAccount, msg: InboundMessage): string {
  const text = msg.text.trim() || "[They sent a photo, file or video over WeChat, which you can't see yet — tell them.]";
  return msg.fromUserId === account.ownerUserId ? text : `[${msg.fromUserId} on WeChat] ${text}`;
}

export class ChannelManager {
  private store: ChannelStore | null = null;
  private readonly monitors = new Map<string, ILinkClient>();
  private readonly logins = new Map<string, PendingLogin>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: BotsHost,
    private readonly relay: Relay,
    private readonly makeClient: (baseUrl?: string) => ILinkClient = (baseUrl) => new ILinkClient(baseUrl),
    private readonly startChatImpl: typeof startChat = startChat,
  ) {
    host.onAttach(() => void this.startMonitors().catch((error: unknown) => console.error("paseo-bots: couldn't start the channel monitors", error)));
  }

  // ------------------------------------------------------------------ store

  private async load(): Promise<ChannelStore> {
    if (this.store) return this.store;
    try {
      this.store = ChannelStoreSchema.parse(JSON.parse(await readFile(storePath(), "utf8")));
    } catch {
      this.store = EMPTY_CHANNEL_STORE;
    }
    return this.store;
  }

  /** One change to channels.json at a time. */
  private update<T>(change: (store: ChannelStore) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const store = await this.load();
      const result = await change(store);
      await mkdir(pluginDataPath(), { recursive: true });
      await writeFile(storePath(), JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }

  // ---------------------------------------------------------------- monitors

  private async startMonitors(): Promise<void> {
    const { accounts } = await this.load();
    for (const account of accounts) this.startMonitor(account);
  }

  private startMonitor(account: ChannelAccount): void {
    if (this.monitors.has(account.id)) return;
    const client = this.makeClient(account.baseUrl);
    client.setToken(account.token);
    this.monitors.set(account.id, client);
    void this.monitor(account, client).catch((error: unknown) => console.error(`paseo-bots: channel ${account.ilinkBotId} monitor crashed`, error));
  }

  private async monitor(account: ChannelAccount, client: ILinkClient): Promise<void> {
    let buf = (await this.load()).syncBuf[account.id] ?? "";
    while (this.monitors.get(account.id) === client) {
      try {
        const updates = await client.getUpdates(buf);
        // The cursor advances only after every message is handled: a failure
        // replays the batch (duplicates) rather than dropping it (loss).
        for (const msg of updates.messages) await this.inbound(account, client, msg);
        buf = updates.syncBuf;
        if (updates.messages.length) await this.update((store) => void (store.syncBuf[account.id] = buf));
      } catch (error) {
        if (this.monitors.get(account.id) !== client) return;
        if (error instanceof ILinkError && error.errcode === SESSION_EXPIRED) {
          console.error(`paseo-bots: WeChat account ${account.ilinkBotId} signed out; scan the QR code again`);
          break;
        }
        console.error(`paseo-bots: channel ${account.ilinkBotId} poll failed, retrying`, error);
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, RETRY_MS);
        await promise;
      }
    }
    this.monitors.delete(account.id);
  }

  /** One inbound direct message: mapped to its Paseo chat and sent in. */
  private async inbound(account: ChannelAccount, client: ILinkClient, msg: InboundMessage): Promise<void> {
    if (msg.groupId || !allows(account, msg.fromUserId)) return;
    const store = await this.load();
    const session = store.sessions.find((entry) => entry.accountId === account.id && entry.fromUserId === msg.fromUserId);
    if (msg.contextToken && session) session.contextToken = msg.contextToken;
    if (session) {
      await this.update(() => {});
      await this.host.requirePaseo().agents.ref(session.chatId).send(frameInbound(account, msg));
      return;
    }
    const bot = await this.host.bot(account.botId);
    if (!bot) {
      console.error(`paseo-bots: channel ${account.ilinkBotId} is bound to a bot that no longer exists (${account.botId})`);
      return;
    }
    const chatId = await this.startChatImpl(this.host, this.relay, bot, {
      prompt: frameInbound(account, msg),
      title: `WeChat: ${msg.fromUserId}`,
      labels: { [CHANNEL_ACCOUNT_LABEL]: account.id, [CHANNEL_FROM_LABEL]: msg.fromUserId },
    });
    await this.update((store) => void store.sessions.push({ accountId: account.id, fromUserId: msg.fromUserId, chatId, contextToken: msg.contextToken }));
  }

  /** turnEnded's half: the chat's reply goes back to the WeChat user. */
  async sendReply(accountId: string, fromUserId: string, text: string): Promise<void> {
    const store = await this.load();
    const account = store.accounts.find((entry) => entry.id === accountId);
    if (!account) return;
    const client = this.monitors.get(accountId) ?? this.makeClient(account.baseUrl);
    client.setToken(account.token);
    const session = store.sessions.find((entry) => entry.accountId === accountId && entry.fromUserId === fromUserId);
    await client.sendText(fromUserId, session?.contextToken ?? null, text);
  }

  // ------------------------------------------------------------------ logins

  /** QR login step 1: a code to show, and a background task that finishes the login. */
  async startWechatLogin(botId: string): Promise<{ loginId: string; qrUrl: string }> {
    const now = Date.now();
    for (const [id, login] of this.logins) if (now - login.startedAt > LOGIN_KEEP_MS) this.logins.delete(id);
    const client = this.makeClient();
    const { qrcode, qrUrl } = await client.getQRCode();
    const loginId = randomUUID();
    const login: PendingLogin = { botId, startedAt: now, client, qrcode, qrUrl, status: "wait", account: null, error: null };
    this.logins.set(loginId, login);
    void this.runLogin(login).catch((error: unknown) => {
      login.status = "error";
      login.error = error instanceof Error ? error.message : String(error);
    });
    return { loginId, qrUrl };
  }

  /** QR login step 2, polled by the app until a terminal status. */
  pollWechatLogin(loginId: string): { status: LoginStatus; qrUrl: string; account: ChannelAccountInfo | null; error: string | null } {
    const login = this.logins.get(loginId);
    if (!login) return { status: "error", qrUrl: "", account: null, error: "This login is gone; start it again." };
    return { status: login.status, qrUrl: login.qrUrl, account: login.account, error: login.error };
  }

  private async runLogin(login: PendingLogin): Promise<void> {
    const deadline = login.startedAt + LOGIN_TIMEOUT_MS;
    let refreshes = 0;
    while (Date.now() < deadline) {
      const status = await login.client.pollQRCodeStatus(login.qrcode);
      if (status.status === "wait" || status.status === "scaned") {
        login.status = status.status;
        continue;
      }
      if (status.status === "expired") {
        refreshes += 1;
        if (refreshes > LOGIN_MAX_REFRESHES) {
          login.status = "expired";
          return;
        }
        const fresh = await login.client.getQRCode();
        login.qrcode = fresh.qrcode;
        login.qrUrl = fresh.qrUrl;
        login.status = "wait";
        continue;
      }
      if (!status.botToken || !status.ilinkBotId) {
        login.status = "error";
        login.error = "Login confirmed without an account token; try again.";
        return;
      }
      const account: ChannelAccount = {
        id: randomUUID(),
        type: "wechat",
        botId: login.botId,
        ilinkBotId: status.ilinkBotId,
        token: status.botToken,
        baseUrl: status.baseUrl || ILINK_BASE_URL,
        ownerUserId: status.ilinkUserId ?? null,
        allowFrom: [],
      };
      await this.update((store) => void store.accounts.push(account));
      this.startMonitor(account);
      login.status = "confirmed";
      login.account = infoOf(account, true);
      return;
    }
    login.status = "expired";
  }

  // ------------------------------------------------------------------ RPC side

  async listForBot(botId: string): Promise<ChannelAccountInfo[]> {
    const { accounts } = await this.load();
    return accounts.filter((account) => account.botId === botId).map((account) => infoOf(account, this.monitors.has(account.id)));
  }

  async disconnect(accountId: string): Promise<boolean> {
    this.monitors.delete(accountId);
    return this.update((store) => {
      const before = store.accounts.length;
      store.accounts = store.accounts.filter((account) => account.id !== accountId);
      store.sessions = store.sessions.filter((session) => session.accountId !== accountId);
      delete store.syncBuf[accountId];
      return store.accounts.length < before;
    });
  }
}

/** The labels turnEnded reads to route a chat's reply back over its channel. */
export function channelOf(labels: Record<string, string>): { accountId: string; fromUserId: string } | null {
  const accountId = labels[CHANNEL_ACCOUNT_LABEL];
  const fromUserId = labels[CHANNEL_FROM_LABEL];
  return accountId && fromUserId ? { accountId, fromUserId } : null;
}

/** How a failed turn is announced to the WeChat user. */
export function channelFailure(error: string): string {
  return `[Something went wrong on my side: ${foldText(error, 200)} — try again in a moment.]`;
}
