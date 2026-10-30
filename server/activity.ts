import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { lastTurn, logLine, type TimelineItemLike } from "../shared/activity";
import type { BotsHost } from "./host";
import type { MemoryJournal } from "./journal";
import { appendDailyLog } from "./memory";
import type { RoutineScheduler } from "./scheduler";

// What happens around each turn of a bot's chat: the journal notes memory
// changes, and the daily log gets a line saying what the bot did.

export async function turnStarted(host: BotsHost, journal: MemoryJournal, { agent }: PluginLifecycleEvents["agent.turn_started"]): Promise<void> {
  const botId = await host.botIdOf(agent.id);
  if (botId) await journal.begin(botId);
}

/**
 * The turn's items. Paseo 0.13.0+ emits agent.turn_ended with an empty
 * timeline, but the daemon still has them, so the reply is refetched before
 * giving up on it; routine cards and the daily log both read it.
 */
async function turnTimeline(host: BotsHost, agentId: string, fromEvent: PluginLifecycleEvents["agent.turn_ended"]["timeline"]): Promise<readonly TimelineItemLike[]> {
  if (fromEvent.length > 0) return fromEvent;
  const page = await host.paseo?.agents
    .ref(agentId)
    .timeline.refetch({ direction: "tail", projection: "projected", limit: 80 })
    .catch(() => null);
  if (!page || page.error || page.entries.length === 0) return fromEvent;
  return page.entries.map((entry) => entry.item as TimelineItemLike);
}

export async function turnEnded(host: BotsHost, journal: MemoryJournal, scheduler: Pick<RoutineScheduler, "finished">, { agent, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"]): Promise<void> {
  const chat = await host.chatOf(agent.id);
  if (!chat) return;
  const { botId } = chat;
  const title = chat.title?.trim() || agent.title?.trim() || "Untitled chat";
  await journal.end(botId, { id: agent.id, title });
  const { reply, tools } = lastTurn(await turnTimeline(host, agent.id, timeline));
  if (chat.routineId) await scheduler.finished(chat.routineId, agent.id, outcome, reply);
  if (outcome.kind === "canceled") return;
  const line = logLine({ at: new Date(), chat: title, reply, tools, failure: outcome.kind === "failed" ? outcome.error.message : null });
  if (line) await appendDailyLog(botId, line);
}
