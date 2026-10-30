import { z } from "zod";

/**
 * IM channels: an outside account (WeChat over Tencent's iLink bot API first)
 * bound to a bot, whose direct chats map to Paseo chats one-to-one.
 *
 * A channel-started chat carries CHANNEL_ACCOUNT_LABEL and CHANNEL_FROM_LABEL;
 * a finished turn in it sends the reply back over the channel (server/activity).
 */

export const CHANNEL_ACCOUNT_LABEL = "paseo-bots.channel-account";
export const CHANNEL_FROM_LABEL = "paseo-bots.channel-from";

export const ChannelAccountSchema = z.object({
  id: z.string(),
  type: z.literal("wechat"),
  /** The bot whose chats this account talks to. */
  botId: z.string(),
  /** iLink bot account id, e.g. "hex@im.bot". */
  ilinkBotId: z.string(),
  /** Bearer token from QR login; channels.json is written mode 0600. */
  token: z.string(),
  /** API base URL returned by login (defaults to ilinkai.weixin.qq.com). */
  baseUrl: z.string(),
  /** iLink user id of the person who scanned the QR code. */
  ownerUserId: z.string().nullable(),
  /** Extra iLink user ids allowed to talk; the owner is always allowed. */
  allowFrom: z.array(z.string()),
});
export type ChannelAccount = z.infer<typeof ChannelAccountSchema>;

/** One direct chat on a channel, mapped to its Paseo chat. */
export const ChannelSessionSchema = z.object({
  accountId: z.string(),
  /** The other side's iLink user id. */
  fromUserId: z.string(),
  chatId: z.string(),
  /** Latest context token from their messages, echoed verbatim in replies. */
  contextToken: z.string().nullable(),
});
export type ChannelSession = z.infer<typeof ChannelSessionSchema>;

export const ChannelStoreSchema = z.object({
  accounts: z.array(ChannelAccountSchema),
  sessions: z.array(ChannelSessionSchema),
  /** Long-poll cursor (get_updates_buf) per account id. */
  syncBuf: z.record(z.string(), z.string()),
});
export type ChannelStore = z.infer<typeof ChannelStoreSchema>;

export const EMPTY_CHANNEL_STORE: ChannelStore = { accounts: [], sessions: [], syncBuf: {} };
