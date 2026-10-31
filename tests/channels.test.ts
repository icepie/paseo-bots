import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeBot, fakeHost } from "./helpers";
import type { ILinkClient, InboundMessage } from "../server/channels/ilink";
import type { ChannelManager } from "../server/channels/manager";

beforeAll(() => {
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "paseo-bots-channels-"));
});

describe("iLink client", () => {
  it("parses updates: text and voice-to-text in, own and empty messages out", async () => {
    const { ILinkClient } = await import("../server/channels/ilink");
    const payload = {
      ret: 0,
      msgs: [
        { message_id: 1, message_type: 1, from_user_id: "u1", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "hello" } }] },
        { message_id: 2, message_type: 2, from_user_id: "bot", item_list: [{ type: 1, text_item: { text: "own" } }] },
        { message_id: 3, message_type: 1, from_user_id: "u2", item_list: [{ type: 3, voice_item: { text: "said aloud" } }] },
        { message_id: 4, message_type: 1, from_user_id: "u3", group_id: "g1", item_list: [{ type: 2, image_item: {} }] },
      ],
      get_updates_buf: "buf-2",
      longpolling_timeout_ms: 30_000,
    };
    const requests: Array<{ url: string; body: { get_updates_buf?: string }; authorization: string | null }> = [];
    const client = new ILinkClient("https://ilink.test", null, (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      requests.push({ url, body: JSON.parse(init.body), authorization: init.headers.Authorization ?? null });
      return new Response(JSON.stringify(payload));
    }) as never);
    client.setToken("tok");

    const updates = await client.getUpdates("buf-1");
    expect(updates.messages).toEqual([
      { messageId: 1, fromUserId: "u1", groupId: null, text: "hello", contextToken: "ctx", unsupported: false },
      { messageId: 3, fromUserId: "u2", groupId: null, text: "said aloud", contextToken: null, unsupported: false },
      { messageId: 4, fromUserId: "u3", groupId: "g1", text: "", contextToken: null, unsupported: true },
    ]);
    expect(updates.syncBuf).toBe("buf-2");
    expect(requests).toMatchObject([{ url: "https://ilink.test/ilink/bot/getupdates", body: { get_updates_buf: "buf-1" }, authorization: "Bearer tok" }]);
  });

  it("chunks long replies and echoes the context token", async () => {
    const { ILinkClient } = await import("../server/channels/ilink");
    const bodies: Array<{ msg: { to_user_id: string; context_token?: string; item_list: Array<{ text_item?: { text?: string } }> } }> = [];
    const client = new ILinkClient("https://ilink.test", null, (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ret: 0 }));
    }) as never);
    client.setToken("tok");

    await client.sendText("u1", "ctx-9", "x".repeat(4_000));
    expect(bodies).toHaveLength(3);
    expect(bodies.map((call) => call.msg.item_list[0].text_item?.text?.length)).toEqual([1_800, 1_800, 400]);
    expect(bodies.every((call) => call.msg.to_user_id === "u1" && call.msg.context_token === "ctx-9")).toBe(true);
  });

  it("maps the confirmed login's snake_case fields", async () => {
    const { ILinkClient } = await import("../server/channels/ilink");
    const client = new ILinkClient("https://ilink.test", null, (async () => new Response(
      JSON.stringify({ ret: 0, status: "confirmed", bot_token: "tok", ilink_bot_id: "wx@im.bot", baseurl: "https://ilink.test", ilink_user_id: "owner-1" }),
    )) as never);
    expect(await client.pollQRCodeStatus("q1")).toEqual({ status: "confirmed", botToken: "tok", ilinkBotId: "wx@im.bot", baseUrl: "https://ilink.test", ilinkUserId: "owner-1" });
  });

  it("fails on the server's error codes so the monitor can react", async () => {
    const { ILinkClient, ILinkError } = await import("../server/channels/ilink");
    const client = new ILinkClient("https://ilink.test", null, (async () => new Response(JSON.stringify({ ret: -14, errcode: -14, errmsg: "session timeout" }))) as never);
    const failure = await client.getUpdates("").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ILinkError);
    expect((failure as InstanceType<typeof ILinkError>).errcode).toBe(-14);
  });
});

describe("channel manager", () => {
  it("logs in by QR, routes direct chats to one Paseo chat each, and replies over the channel", async () => {
    const { ChannelManager } = await import("../server/channels/manager");
    const bot = makeBot({ id: "bot-1", name: "Inbox" });
    const host = fakeHost([bot]);
    const sentToChats: Array<{ id: string; text: string }> = [];
    const sentToWechat: Array<{ to: string; ctx: string | null; text: string }> = [];
    const updates: InboundMessage[] = [
      { messageId: 1, fromUserId: "owner-1", groupId: null, text: "hello bot", contextToken: "ctx-1", unsupported: false },
      { messageId: 2, fromUserId: "stranger", groupId: null, text: "hi", contextToken: null, unsupported: false },
      { messageId: 3, fromUserId: "owner-1", groupId: "group-1", text: "group hi", contextToken: null, unsupported: false },
      { messageId: 4, fromUserId: "owner-1", groupId: null, text: "second", contextToken: "ctx-2", unsupported: false },
    ];
    // Deterministic signals: the monitor's first poll proves login persisted and
    // monitoring started; the second chat send proves the whole first batch ran.
    const monitoring = Promise.withResolvers<void>();
    const batchDone = Promise.withResolvers<void>();
    const fake = {
      setToken: () => {},
      getQRCode: async () => ({ qrcode: "q1", qrUrl: "https://qr/1" }),
      pollQRCodeStatus: (() => {
        let calls = 0;
        return async () => (calls++ === 0 ? { status: "wait" as const } : { status: "confirmed" as const, botToken: "tok", ilinkBotId: "wx@im.bot", baseurl: "https://ilink.test", ilinkUserId: "owner-1" });
      })(),
      getUpdates: (() => {
        let done = false;
        return async () => {
          monitoring.resolve();
          if (done) return Promise.withResolvers<never>().promise;
          done = true;
          return { messages: updates, syncBuf: "buf-1", nextTimeoutMs: null };
        };
      })(),
      sendText: async (to: string, ctx: string | null, text: string) => void sentToWechat.push({ to, ctx, text }),
    };
    const startedChats: Array<{ prompt: string; title: string; labels: Record<string, string> }> = [];
    const manager: ChannelManager = new ChannelManager(
      host,
      null as never,
      () => fake as unknown as ILinkClient,
      (async (_h: never, _r: never, _b: never, input: { prompt: string; title: string; labels: Record<string, string> }) => {
        startedChats.push(input);
        return "chat-1";
      }) as never,
    );
    host.attach({
      agents: {
        ref: (id: string) => ({
          send: async (text: string) => {
            sentToChats.push({ id, text });
            if (text === "second") batchDone.resolve();
          },
        }),
      },
    } as never);

    const { loginId, qrUrl } = await manager.startWechatLogin("bot-1");
    expect(qrUrl).toBe("https://qr/1");
    await monitoring.promise;
    expect(manager.pollWechatLogin(loginId).status).toBe("confirmed");
    const accounts = await manager.listForBot("bot-1");
    expect(accounts).toMatchObject([{ type: "wechat", ilinkBotId: "wx@im.bot", ownerUserId: "owner-1", running: true }]);

    await batchDone.promise;
    expect(startedChats).toHaveLength(1);
    expect(startedChats[0]).toMatchObject({ prompt: "hello bot", title: "WeChat: owner-1", labels: { "paseo-bots.channel-account": accounts[0].id, "paseo-bots.channel-from": "owner-1" } });
    // The stranger and the group message never reached the bot; the owner's
    // second message went into the same chat, not a new one.
    expect(sentToChats).toEqual([{ id: "chat-1", text: "second" }]);

    await manager.sendReply(accounts[0].id, "owner-1", "the answer");
    expect(sentToWechat).toEqual([{ to: "owner-1", ctx: "ctx-2", text: "the answer" }]);

    expect(await manager.disconnect(accounts[0].id)).toBe(true);
    expect(await manager.listForBot("bot-1")).toEqual([]);
  });
});
