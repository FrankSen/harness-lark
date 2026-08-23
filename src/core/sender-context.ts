/**
 * Per-turn sender and reply-routing context.
 *
 * The bridge records the Feishu message sender's open_id plus the reply
 * routing (the message to reply to, and whether it lives inside a topic
 * thread) around the agent turn. Tools read these to resolve "who is
 * talking" (and call the Feishu API with that user's access token), and the
 * ask-user card reads the thread routing so its card lands in the same
 * topic thread rather than the main group.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** One inbound turn's identity + reply routing. */
export interface TurnContext {
  /** Sender open_id (for user-scoped Feishu API calls). */
  senderOpenId: string
  /** Message id the reply should anchor to (topic thread root or the inbound message). */
  replyToMessageId?: string
  /** Whether the inbound message lives inside a topic thread (reply_in_thread). */
  replyInThread?: boolean
}

const storage = new AsyncLocalStorage<TurnContext>()

/** Run `fn` with the given turn context in scope for the async chain. */
export function runWithTurn<T>(ctx: TurnContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

/** Read the current turn's context, or undefined outside a turn. */
export function currentTurn(): TurnContext | undefined {
  return storage.getStore()
}

/** Read the current turn's sender open_id, or undefined outside a turn. */
export function currentSenderOpenId(): string | undefined {
  return storage.getStore()?.senderOpenId
}

/** Back-compat alias kept for existing call sites. */
export function runWithSender<T>(senderOpenId: string, fn: () => T): T {
  return storage.run({ senderOpenId }, fn)
}