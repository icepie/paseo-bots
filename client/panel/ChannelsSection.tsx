import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { channelDisconnectRpc, channelListRpc, channelWechatLoginPollRpc, channelWechatLoginStartRpc } from "../../shared/rpc";
import { useBotHost } from "../data";
import { confirmDialog, errorText } from "../native";
import { ui } from "../typography";
import { QrCode } from "../ui/QrCode";
import type { PanelProps } from "./BotPanel";
import { Button, CardNote, SectionLink, SheetActions, StatusBadge } from "./controls";

type Colors = PluginTheme["colors"];

const QR_SIZE = 220;
const POLL_MS = 1500;

/**
 * IM accounts bound to the bot (WeChat over Tencent's iLink first). The daemon
 * holds the login token and syncs the account's direct chats with the bot's.
 */
export function ChannelsSection({ colors, bot, localHost }: Pick<PanelProps, "colors" | "bot" | "localHost">) {
  const host = useBotHost(bot.hostId, localHost);
  const list = useRpc(channelListRpc);
  const disconnectRpc = useRpc(channelDisconnectRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["paseo-bots", "channels", bot.id];
  const accounts = useQuery({ queryKey: key, queryFn: () => list({ botId: bot.id }), enabled: host.isLocal });
  const [connecting, setConnecting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const disconnect = async (accountId: string, ilinkBotId: string) => {
    const sure = await confirmDialog({
      title: "Disconnect WeChat",
      message: `Disconnect ${ilinkBotId}? The bot stops receiving and sending its messages.`,
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!sure) return;
    setBusyId(accountId);
    try {
      await disconnectRpc({ accountId });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsSection
      title="Channels"
      info="Messaging accounts this bot answers on. Connect one by scanning its QR code; the account's direct chats become chats with the bot."
      trailing={host.isLocal ? <SectionLink colors={colors} label="Connect WeChat" onPress={() => setConnecting(true)} /> : undefined}
    >
      <SettingsCard>
        {!host.isLocal ? <CardNote colors={colors} text="Only bots on this host can use channels" /> : null}
        {host.isLocal && accounts.isLoading ? <CardNote colors={colors} loading text="Loading..." /> : null}
        {host.isLocal && accounts.error ? <CardNote colors={colors} text={errorText(accounts.error)} /> : null}
        {host.isLocal && accounts.data?.accounts.length === 0 ? <CardNote colors={colors} text="No channels connected yet" /> : null}
        {(accounts.data?.accounts ?? []).map((account) => (
          <SettingsRow key={account.id} label="WeChat" hint={account.ilinkBotId}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <StatusBadge colors={colors} label={account.running ? "Running" : "Stopped"} variant={account.running ? "success" : "muted"} />
              <Button colors={colors} label="Disconnect" loading={busyId === account.id} disabled={busyId !== null} onPress={() => void disconnect(account.id, account.ilinkBotId)} />
            </View>
          </SettingsRow>
        ))}
      </SettingsCard>
      {connecting ? (
        <WeChatLoginDialog
          colors={colors}
          botId={bot.id}
          onClose={() => setConnecting(false)}
          onConnected={() => {
            setConnecting(false);
            void queryClient.invalidateQueries({ queryKey: key });
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * The QR login: starts a session, shows the code and polls until it's
 * confirmed, finally expired or failed. A refreshed code replaces the image.
 */
function WeChatLoginDialog({ colors, botId, onClose, onConnected }: { colors: Colors; botId: string; onClose(): void; onConnected(): void }) {
  const start = useRpc(channelWechatLoginStartRpc);
  const poll = useRpc(channelWechatLoginPollRpc);
  const toast = useToast();
  const [login, setLogin] = useState<{ loginId: string; qrUrl: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLogin(null);
    setStartError(null);
    start({ botId })
      .then((session) => {
        if (!cancelled) setLogin({ loginId: session.loginId, qrUrl: session.qrUrl });
      })
      .catch((error: unknown) => {
        if (!cancelled) setStartError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [start, botId, attempt]);

  const result = useQuery({
    queryKey: ["paseo-bots", "channels", "wechat-login", login?.loginId],
    queryFn: () => poll({ loginId: login!.loginId }),
    enabled: login !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "wait" || status === "scaned" || status === undefined ? POLL_MS : false;
    },
    retry: false,
  });

  const status = result.data?.status ?? "wait";
  // A thrown poll is transient (polling goes on); the rest end the session.
  const terminal = startError ?? (status === "error" ? (result.data?.error ?? "Login failed") : null) ?? (status === "expired" ? "The code expired. Try again." : null);
  const failed = terminal ?? (result.error ? errorText(result.error) : null);

  useEffect(() => {
    if (result.data?.status === "confirmed") {
      toast.show("WeChat connected", { variant: "success" });
      onConnected();
    }
  }, [result.data?.status]);

  const statusText = failed ?? (status === "scaned" ? "Scanned — confirm the login on your phone" : status === "confirmed" ? "Connected" : "Scan the code with WeChat");
  const qrUrl = result.data?.qrUrl ?? login?.qrUrl ?? null;

  return (
    <Modal title="Connect WeChat" open onOpenChange={(next) => !next && onClose()}>
      <Modal.Content contentContainerStyle={{ alignItems: "center", gap: 16 }}>
        <View style={{ width: QR_SIZE, height: QR_SIZE, borderRadius: 8, backgroundColor: "#ffffff", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {qrUrl && !startError ? <QrCode text={qrUrl} size={QR_SIZE - 16} /> : <ActivityIndicator color={colors.foregroundMuted} />}
        </View>
        <Text style={{ fontSize: ui(14), color: failed ? colors.statusDanger : colors.foregroundMuted, textAlign: "center" }}>{statusText}</Text>
        <SheetActions>
          <Button colors={colors} variant="ghost" label="Cancel" onPress={onClose} />
          {terminal ? <Button colors={colors} variant="default" label="Try again" onPress={() => setAttempt((count) => count + 1)} /> : null}
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
