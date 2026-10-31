import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
        { message_id: 5, message_type: 1, from_user_id: "u4", item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "cdn-img", aes_key: "a2V5" }, aeskey: "00112233445566778899aabbccddeeff" } }] },
        { message_id: 6, message_type: 1, from_user_id: "u5", item_list: [{ type: 4, file_item: { media: { encrypt_query_param: "cdn-file", aes_key: "a2V5" }, file_name: "报表.xlsx" } }] },
        { message_id: 7, message_type: 1, from_user_id: "u6", item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "cdn-keyless" } } }] },
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
      { messageId: 1, fromUserId: "u1", groupId: null, text: "hello", contextToken: "ctx", media: null, unsupported: false },
      { messageId: 3, fromUserId: "u2", groupId: null, text: "said aloud", contextToken: null, media: null, unsupported: false },
      { messageId: 4, fromUserId: "u3", groupId: "g1", text: "", contextToken: null, media: null, unsupported: true },
      { messageId: 5, fromUserId: "u4", groupId: null, text: "", contextToken: null, media: { kind: "image", name: null, cdnParam: "cdn-img", aesKeyHex: "00112233445566778899aabbccddeeff", aesKeyBase64: "a2V5" }, unsupported: false },
      { messageId: 6, fromUserId: "u5", groupId: null, text: "", contextToken: null, media: { kind: "file", name: "报表.xlsx", cdnParam: "cdn-file", aesKeyHex: null, aesKeyBase64: "a2V5" }, unsupported: false },
      // Media without its key can never be decrypted — reported as unreadable.
      { messageId: 7, fromUserId: "u6", groupId: null, text: "", contextToken: null, media: null, unsupported: true },
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

  it("downloads and decrypts CDN media, both key encodings", async () => {
    const { ILinkClient } = await import("../server/channels/ilink");
    const { createCipheriv } = await import("node:crypto");
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plain = Buffer.from("fake png bytes \x89\x50\x4e\x47");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const client = new ILinkClient("https://ilink.test", null, (async () => new Response(new Uint8Array(encrypted))) as never);

    // Images: the key arrives hex-encoded on the item.
    await expect(client.downloadMedia({ kind: "image", name: null, cdnParam: "p1", aesKeyHex: key.toString("hex"), aesKeyBase64: null })).resolves.toEqual(plain);
    // Files: base64 of the raw 16 key bytes.
    await expect(client.downloadMedia({ kind: "file", name: "a.bin", cdnParam: "p2", aesKeyHex: null, aesKeyBase64: key.toString("base64") })).resolves.toEqual(plain);
    // Files again: base64 of the key's hex string.
    await expect(client.downloadMedia({ kind: "file", name: "a.bin", cdnParam: "p3", aesKeyHex: null, aesKeyBase64: Buffer.from(key.toString("hex"), "utf-8").toString("base64") })).resolves.toEqual(plain);
  });

  it("uploads encrypted media and sends it with the CDN coordinates", async () => {
    const { ILinkClient } = await import("../server/channels/ilink");
    const { createDecipheriv } = await import("node:crypto");
    const plain = Buffer.from("photo bytes".repeat(100));
    const calls: Array<{ url: string; body: Buffer; downloadParam: string | null }> = [];
    let fullUrlNext = false;
    const client = new ILinkClient("https://ilink.test", "tok", (async (url: string, init: { body: string | Buffer; headers?: Record<string, string> }) => {
      if (url.includes("getuploadurl")) {
        // Live servers answer upload_full_url; the reference protocol names upload_param.
        const body = fullUrlNext ? { ret: 0, upload_full_url: "https://cdn.test/upload?full=1" } : { ret: 0, upload_param: "up-param" };
        fullUrlNext = !fullUrlNext;
        return new Response(JSON.stringify(body));
      }
      if (url.includes("/upload?")) {
        calls.push({ url, body: Buffer.from(init.body as Buffer), downloadParam: null });
        return new Response("", { headers: { "x-encrypted-param": "dl-param" } });
      }
      return new Response(JSON.stringify({ ret: 0 }));
    }) as never);

    const uploaded = await client.uploadMedia("image", "u1", plain);
    expect(uploaded).toMatchObject({ downloadParam: "dl-param", rawSize: plain.length, cipherSize: Math.ceil((plain.length + 1) / 16) * 16 });
    // The CDN got the ciphertext under our filekey; it decrypts with the key we sent.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("encrypted_query_param=up-param");
    expect(calls[0].url).toContain("filekey=");
    // upload_full_url is posted to verbatim.
    await client.uploadMedia("file", "u1", plain);
    expect(calls[1].url).toBe("https://cdn.test/upload?full=1");
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(Buffer.from(uploaded.aesKeyBase64, "base64").toString("utf-8"), "hex"), null);
    expect(Buffer.concat([decipher.update(calls[0].body), decipher.final()])).toEqual(plain);

    const sent: Array<{ msg: { item_list: unknown[]; context_token?: string } }> = [];
    const sending = new ILinkClient("https://ilink.test", "tok", (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ret: 0 }));
    }) as never);
    await sending.sendMedia("u1", "ctx-1", "image", "photo.png", uploaded);
    expect(sent[0].msg.context_token).toBe("ctx-1");
    expect(sent[0].msg.item_list).toEqual([{ type: 2, image_item: { media: { encrypt_query_param: "dl-param", aes_key: uploaded.aesKeyBase64, encrypt_type: 1 }, mid_size: uploaded.cipherSize } }]);
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
      { messageId: 1, fromUserId: "owner-1", groupId: null, text: "hello bot", contextToken: "ctx-1", media: null, unsupported: false },
      { messageId: 2, fromUserId: "stranger", groupId: null, text: "hi", contextToken: null, media: null, unsupported: false },
      { messageId: 3, fromUserId: "owner-1", groupId: "group-1", text: "group hi", contextToken: null, media: null, unsupported: false },
      { messageId: 4, fromUserId: "owner-1", groupId: null, text: "", contextToken: "ctx-1b", media: { kind: "image", name: null, cdnParam: "cdn-1", aesKeyHex: "00112233445566778899aabbccddeeff", aesKeyBase64: null }, unsupported: false },
      { messageId: 5, fromUserId: "owner-1", groupId: null, text: "second", contextToken: "ctx-2", media: null, unsupported: false },
    ];
    // Deterministic signals: the monitor's first poll proves login persisted and
    // monitoring started; the second chat send proves the whole first batch ran.
    const monitoring = Promise.withResolvers<void>();
    const batchDone = Promise.withResolvers<void>();
    const uploadedMedia: Array<{ kind: string; to: string; size: number }> = [];
    const sentMedia: Array<{ to: string; ctx: string | null; kind: string; name: string }> = [];
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
      downloadMedia: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x66, 0x61, 0x6b, 0x65]),
      uploadMedia: async (kind: string, to: string, bytes: Buffer) => {
        uploadedMedia.push({ kind, to, size: bytes.length });
        return { downloadParam: "dl", aesKeyBase64: "aw==", rawSize: bytes.length, cipherSize: bytes.length + 8 };
      },
      sendMedia: async (to: string, ctx: string | null, kind: string, name: string) => void sentMedia.push({ to, ctx, kind, name }),
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
    expect(startedChats[0]).toMatchObject({ title: "WeChat: owner-1", labels: { "paseo-bots.channel-account": accounts[0].id, "paseo-bots.channel-from": "owner-1" } });
    // The first message carries the channel note, then the owner's text.
    expect(startedChats[0].prompt).toContain("![caption](/absolute/path.png)");
    expect(startedChats[0].prompt.endsWith("hello bot")).toBe(true);
    // The stranger and the group message never reached the bot. The photo was
    // decrypted into the bot's folder and the note went into the same chat.
    const { botDataPath } = await import("../server/bot-home");
    const photoPath = join(botDataPath("bot-1"), "media", "photo-4.png");
    expect(sentToChats).toEqual([
      { id: "chat-1", text: "[They sent a photo over WeChat — saved to media/photo-4.png in your folder; open it with your tools to see it.]" },
      { id: "chat-1", text: "second" },
    ]);
    expect(await readFile(photoPath)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x66, 0x61, 0x6b, 0x65]));

    await manager.sendReply(accounts[0].id, "owner-1", "the answer");
    expect(sentToWechat).toEqual([{ to: "owner-1", ctx: "ctx-2", text: "the answer" }]);

    // Reply markup: an image embed and a file directive travel as media.
    const shotPath = join(process.env.PASEO_HOME ?? "", "shot.png");
    const docPath = join(process.env.PASEO_HOME ?? "", "notes.txt");
    await writeFile(shotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x66, 0x61, 0x6b, 0x65]));
    await writeFile(docPath, "meeting notes");
    await manager.sendReply(accounts[0].id, "owner-1", `看这些\n![截图](${shotPath})\n和 [file: ${docPath}] 吧`);
    expect(sentToWechat[1]).toEqual({ to: "owner-1", ctx: "ctx-2", text: "看这些\n\n和  吧" });
    expect(uploadedMedia).toEqual([
      { kind: "image", to: "owner-1", size: 8 },
      { kind: "file", to: "owner-1", size: 13 },
    ]);
    expect(sentMedia).toEqual([
      { to: "owner-1", ctx: "ctx-2", kind: "image", name: "shot.png" },
      { to: "owner-1", ctx: "ctx-2", kind: "file", name: "notes.txt" },
    ]);

    expect(await manager.disconnect(accounts[0].id)).toBe(true);
    expect(await manager.listForBot("bot-1")).toEqual([]);
  });
});
