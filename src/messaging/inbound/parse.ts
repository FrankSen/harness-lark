/**
 * Inbound Feishu message parsing.
 *
 * Converts a raw `im.message.receive_v1` event into a normalized
 * MessageContext: mention bookkeeping plus plain-text extraction.
 * Adapted from openclaw-lark's parse.ts, simplified for harness-lark.
 */

import type {
  FeishuMessageEvent,
  MentionInfo,
  MessageContext,
  RawMention,
} from '../../core/types.ts'

/** True when a mention references @all. */
function isMentionAll(m: RawMention): boolean {
  return m.key === 'ALL' || m.key === 'all' || Boolean(m.name === '@all' || m.name === '@所有人')
}

/**
 * Parse a raw Feishu message event into a normalized MessageContext.
 * @param event - The raw event from the WebSocket gateway.
 * @param botOpenId - The bot's open_id, used to flag bot mentions.
 */
export function parseMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): MessageContext {
  const message = event.message
  const msgId = message.message_id ?? 'unknown'
  const chatId = message.chat_id ?? ''

  // Build mention bookkeeping.
  const mentionList: MentionInfo[] = []
  let mentionAll = false
  for (const m of message.mentions ?? []) {
    if (isMentionAll(m)) {
      mentionAll = true
      continue
    }
    const openId = m.id?.open_id ?? ''
    if (!openId) continue
    mentionList.push({
      key: m.key,
      openId,
      name: m.name,
      isBot: Boolean(botOpenId && openId === botOpenId),
    })
  }

  const mentionedBot = mentionList.some((m) => m.isBot)

  const text = extractPlainText(event)
  const createTime = message.create_time ? Number(message.create_time) : undefined
  const fileKey = extractFileKey(event)
  const imageKey = extractImageKey(event)

  return {
    messageId: msgId,
    chatId,
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    // A real topic thread carries `thread_id` (omt_*); `root_id` alone is a
    // quote-reply chain in a normal group, NOT a thread (do not thread on it).
    threadId: message.thread_id || undefined,
    rootId: message.root_id || undefined,
    senderOpenId: event.sender?.sender_id?.open_id ?? '',
    mentions: mentionList,
    mentionedBot,
    mentionAll,
    text,
    fileKey,
    imageKey,
    rawContent: message.content,
    createTime,
  }
}

/** Extract file_key from a file/audio/media message content payload. */
function extractFileKey(event: FeishuMessageEvent): string | undefined {
  const msgType = event.message.msg_type ?? event.message.message_type ?? ''
  if (msgType !== 'file' && msgType !== 'audio' && msgType !== 'media') return undefined
  const content = event.message.content
  if (!content) return undefined
  try {
    const parsed = JSON.parse(content) as { file_key?: string }
    return parsed.file_key
  } catch {
    return undefined
  }
}

/** Extract image_key from an image message content payload. */
function extractImageKey(event: FeishuMessageEvent): string | undefined {
  const msgType = event.message.msg_type ?? event.message.message_type ?? ''
  if (msgType !== 'image') return undefined
  const content = event.message.content
  if (!content) return undefined
  try {
    const parsed = JSON.parse(content) as { image_key?: string }
    return parsed.image_key
  } catch {
    return undefined
  }
}

/** Extract plain text from a message event across supported msg_types. */
function extractPlainText(event: FeishuMessageEvent): string {
  // SDK v1.65+ delivers schema 2.0 events where the type field is
  // `message_type`; older envelopes use `msg_type`. Accept both.
  const msgType = event.message.msg_type ?? event.message.message_type ?? ''
  const content = event.message.content
  if (!content) return ''

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    switch (msgType) {
      case 'text': {
        const raw = typeof parsed.text === 'string' ? parsed.text : ''
        return resolveMentions(raw, event.message.mentions ?? [])
      }
      case 'post': {
        const title = typeof parsed.title === 'string' ? parsed.title : ''
        const blocks = extractPostText(parsed)
        return title ? `${title}\n${blocks}` : blocks
      }
      case 'image':
        return '[图片]'
      case 'file':
        return `[文件: ${typeof parsed.file_name === 'string' ? parsed.file_name : ''}]`
      case 'audio':
        return '[语音]'
      case 'media':
        return '[视频]'
      case 'interactive':
        return extractCardText(parsed)
      case 'system':
        return '[系统消息]'
      default:
        return `[未知消息类型: ${msgType}]`
    }
  } catch {
    // Not JSON — treat the raw content as text.
    return content
  }
}

/** Recursively collect text from a post-format content payload. */
function extractPostText(parsed: Record<string, unknown>): string {
  const parts: string[] = []
  const seen = new Set<string>()
  const push = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed)
      parts.push(trimmed)
    }
  }

  /** Walk one post block element, handling every element tag Feishu emits. */
  const walkElement = (elem: unknown, depth: number): void => {
    if (depth > 16 || elem == null) return
    if (typeof elem === 'string') {
      push(elem)
      return
    }
    if (Array.isArray(elem)) {
      for (const item of elem) walkElement(item, depth + 1)
      return
    }
    if (typeof elem !== 'object') return
    const e = elem as Record<string, unknown>
    const tag = typeof e.tag === 'string' ? e.tag : ''
    switch (tag) {
      case 'text':
        if (typeof e.text === 'string') push(e.text)
        return
      case 'md':
      case 'markdown':
        if (typeof e.text === 'string') push(e.text)
        else if (typeof e.content === 'string') push(e.content)
        return
      case 'a':
      case 'link':
        if (typeof e.text === 'string') push(e.text)
        return
      case 'at': {
        // post-format mention: name in `user_id` (a display name, not an id)
        // or `text`; emit @name so the model sees who was addressed.
        const name = typeof e.user_id === 'string' ? e.user_id
          : typeof e.text === 'string' ? e.text : ''
        push(name ? `@${name}` : '@')
        return
      }
      case 'img':
      case 'image':
        push('[图片]')
        return
      case 'br':
        return
      default:
        // Unknown tag: fall through and recurse into scalar/container fields.
        for (const key of ['text', 'content', 'elements', 'lines']) {
          const child = e[key]
          if (child !== undefined && child !== null) walkElement(child, depth + 1)
        }
    }
  }

  // New SDK schema 2.0 post payloads use `content` / `content_v2` (rows of
  // element lists); older envelopes use `body`. Prefer `content_v2` (md
  // source) to avoid duplicating the same text from `content` (rendered
  // spans); fall back to `content`, then legacy `body`.
  const sourceKey = parsed.content_v2 !== undefined && Array.isArray(parsed.content_v2)
    ? 'content_v2'
    : parsed.content !== undefined && Array.isArray(parsed.content)
      ? 'content'
      : 'body'
  const rows = parsed[sourceKey]
  if (Array.isArray(rows)) {
    for (const row of rows) walkElement(row, 0)
  }

  // `title` (a plain string) accompanies some posts.
  if (typeof parsed.title === 'string') push(parsed.title)

  return parts.join('')
}

/**
 * Extract human-readable text from an interactive card (msg_type=interactive).
 * Cards may use the schema 2.0 (`json_card`), a legacy `card` object, or a
 * plain header+elements form. Recursively collects text-bearing fields
 * (`content`/`text`/`title`/`label`/`placeholder`) and container fields
 * (`elements`/`fields`/`actions`/`columns`/`options`/`contents`/`property`),
 * so nested layouts (div → markdown, column_set → column, …) yield their text
 * instead of falling back to the bare `[卡片]` placeholder.
 */
function extractCardText(parsed: Record<string, unknown>): string {
  // schema 2.0 card: { json_card: "{...}" }
  if (typeof parsed.json_card === 'string') {
    try {
      return extractCardText(JSON.parse(parsed.json_card) as Record<string, unknown>)
    } catch {
      // fall through to the outer default
    }
  }

  // Feishu delivers interactive cards with the full v2 DSL embedded as a
  // string under `user_dsl` (the top-level `elements` are a degraded fallback
  // like "请升级至最新版本客户端"). Parse and prefer it so the model sees
  // the real card content.
  if (typeof parsed.user_dsl === 'string') {
    try {
      const dsl = JSON.parse(parsed.user_dsl) as Record<string, unknown>
      return extractCardText(dsl)
    } catch {
      // fall through to the outer default
    }
  }

  const parts: string[] = []
  const seen = new Set<string>()
  const push = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed)
      parts.push(trimmed)
    }
  }

  /** Text fields considered "content" on any card node. */
  const TEXT_KEYS = ['content', 'text', 'title', 'label', 'placeholder'] as const
  /** Container fields recursed into for nested text. */
  const CONTAINER_KEYS = ['elements', 'fields', 'actions', 'columns', 'options', 'contents', 'property'] as const

  const walk = (node: unknown, depth: number): void => {
    if (depth > 16 || node == null) return
    if (typeof node === 'string') {
      push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    // Pull top-level text fields, then recurse into containers. The dedup set
    // keeps header.title (via `title`) from duplicating its `content`.
    for (const key of TEXT_KEYS) {
      const value = obj[key]
      if (typeof value === 'string') {
        push(value)
      } else if (value !== undefined && value !== null) {
        // Nested text element ({ tag, content }, { property: { ... } }): dive
        // into it so a title/text/placeholder object yields its inner content.
        walk(value, depth + 1)
      }
    }
    for (const key of CONTAINER_KEYS) {
      const child = obj[key]
      if (child !== undefined && child !== null) walk(child, depth + 1)
    }
  }

  // Card v2 body: { header: {...}, body: { elements: [...] } } — recurse into
  // header and body explicitly since neither is in CONTAINER_KEYS.
  walk(parsed.header, 0)
  walk(parsed.body, 0)
  // Legacy flat form: { elements: [...] } — already covered via CONTAINER_KEYS,
  // but walk the root too in case text sits at top level (e.g. `markdown`).
  walk(parsed.elements, 0)

  return parts.join('\n') || '[卡片]'
}

/**
 * Replace Feishu mention keys (`at_xxx`) in text with human-readable names.
 * A key may appear bare or already prefixed with `@`; both resolve to one
 * `@name` so the replacement never doubles the at-sign.
 * @param raw - Text containing mention keys.
 * @param mentions - The event's mention list.
 */
export function resolveMentions(raw: string, mentions: RawMention[]): string {
  let out = raw
  for (const m of mentions) {
    const name = m.name ?? m.id?.open_id ?? m.key
    // Replace `@key` first (longest, most specific), then bare `key`.
    out = out.split(`@${m.key}`).join(`@${name}`)
    out = out.split(m.key).join(`@${name}`)
  }
  return out
}
