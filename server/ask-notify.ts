// Chats an ask_bot or check_chat call is synchronously waiting on: a finished
// turn there goes back in the tool's own reply, so the asking chat gets no
// separate wake-up note for it (server/activity.ts sends one otherwise).

const waiting = new Set<string>();

/** Chats with a synchronous waiter right now; a finished turn there needs no wake-up note. */
export const watchedChats: ReadonlySet<string> = waiting;

/** Runs `wait` with the chat marked as synchronously watched. */
export async function watchingChat<T>(chatId: string, wait: () => Promise<T>): Promise<T> {
  waiting.add(chatId);
  try {
    return await wait();
  } finally {
    waiting.delete(chatId);
  }
}
