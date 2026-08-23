import { describe, expect, it } from 'vitest'
import { parseMessageEvent, resolveMentions } from '../src/messaging/inbound/parse.ts'
import type { FeishuMessageEvent } from '../src/core/types.ts'

function textEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_chat_1',
      chat_type: 'p2p',
      msg_type: 'text',
      create_time: String(Date.now()),
      content: JSON.stringify({ text: 'hello @at_x' }),
      mentions: [{ key: 'at_x', id: { open_id: 'ou_other' }, name: 'Alice' }],
    },
    ...overrides,
  }
}

describe('parseMessageEvent', () => {
  it('extracts text and resolves mentions to names', () => {
    const ctx = parseMessageEvent(textEvent())
    expect(ctx.messageId).toBe('om_1')
    expect(ctx.chatId).toBe('oc_chat_1')
    expect(ctx.chatType).toBe('p2p')
    expect(ctx.senderOpenId).toBe('ou_user_1')
    expect(ctx.text).toBe('hello @Alice')
    expect(ctx.mentions).toHaveLength(1)
    expect(ctx.mentions[0]).toMatchObject({ openId: 'ou_other', isBot: false })
  })

  it('flags a bot mention when the mention open_id matches the bot', () => {
    const ctx = parseMessageEvent(textEvent(), 'ou_bot')
    expect(ctx.mentions[0]?.isBot).toBe(false)
    const botMention = textEvent({
      message: {
        ...textEvent().message!,
        mentions: [{ key: 'at_bot', id: { open_id: 'ou_bot' }, name: 'Bot' }],
        content: JSON.stringify({ text: 'hi @at_bot' }),
      },
    })
    const botCtx = parseMessageEvent(botMention, 'ou_bot')
    expect(botCtx.mentionedBot).toBe(true)
    expect(botCtx.mentions[0]?.isBot).toBe(true)
  })

  it('detects @all mentions', () => {
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        mentions: [{ key: 'ALL', name: '@all' }],
        content: JSON.stringify({ text: 'everyone' }),
      },
    })
    const ctx = parseMessageEvent(ev)
    expect(ctx.mentionAll).toBe(true)
  })

  it('derives thread id from thread_id or root_id', () => {
    const ev = textEvent({
      message: { ...textEvent().message!, thread_id: 'om_thread' },
    })
    expect(parseMessageEvent(ev).threadId).toBe('om_thread')
  })

  it('maps post messages to text', () => {
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        msg_type: 'post',
        content: JSON.stringify({
          title: 'Title',
          body: [[{ tag: 'text', text: 'line one' }, { tag: 'text', text: 'line two' }]],
        }),
      },
    })
    expect(parseMessageEvent(ev).text).toContain('line one')
    expect(parseMessageEvent(ev).text).toContain('line two')
  })

  it('extracts post messages using the SDK v2 content/content_v2 fields', () => {
    // Feishu SDK v1.65+ events put post rows in `content` / `content_v2`,
    // not the legacy `body` — the topic-creation message bug.
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        msg_type: 'post',
        content: JSON.stringify({
          title: '',
          content: [[
            { tag: 'text', text: '测试 post 格式 ', style: [] },
            { tag: 'text', text: '加粗', style: ['bold'] },
          ]],
          content_v2: [[{ tag: 'md', text: '测试 post 格式 **加粗**' }]],
        }),
      },
    })
    const text = parseMessageEvent(ev).text
    expect(text).toContain('测试 post 格式')
    expect(text).toContain('加粗')
  })

  it('renders post-format mentions as @name', () => {
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        msg_type: 'post',
        content: JSON.stringify({
          content: [[
            { tag: 'at', user_id: '（江山）的智能助手2号' },
            { tag: 'text', text: ' 你好' },
          ]],
        }),
      },
    })
    const text = parseMessageEvent(ev).text
    expect(text).toContain('@（江山）的智能助手2号')
    expect(text).toContain('你好')
  })

  it('returns a placeholder for media types', () => {
    const ev = textEvent({
      message: { ...textEvent().message!, msg_type: 'image', content: '{}' },
    })
    expect(parseMessageEvent(ev).text).toBe('[图片]')
  })

  it('extracts nested interactive card text (v2 json_card, nested div/markdown)', () => {
    const card = JSON.stringify({
      header: { title: { tag: 'plain_text', content: 'Card Title' } },
      body: {
        elements: [
          { tag: 'div', elements: [{ tag: 'markdown', content: '**bold** body' }] },
          { tag: 'note', elements: [{ tag: 'plain_text', content: 'footnote' }] },
        ],
      },
    })
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        msg_type: 'interactive',
        content: JSON.stringify({ json_card: card }),
      },
    })
    const text = parseMessageEvent(ev).text
    expect(text).toContain('Card Title')
    expect(text).toContain('bold')
    expect(text).toContain('footnote')
    expect(text).not.toBe('[卡片]')
  })

  it('extracts legacy flat interactive card elements', () => {
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        msg_type: 'interactive',
        content: JSON.stringify({ elements: [{ tag: 'markdown', content: 'flat card text' }] }),
      },
    })
    expect(parseMessageEvent(ev).text).toContain('flat card text')
  })

  it('prefers the user_dsl card content over the degraded fallback elements', () => {
    // Feishu delivers interactive cards with the real v2 DSL embedded under
    // `user_dsl`; the top-level elements are a degraded client fallback.
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        msg_type: 'interactive',
        content: JSON.stringify({
          title: '测试卡片标题',
          elements: [[
            { tag: 'img', image_key: 'img_x' },
            { tag: 'text', text: '请升级至最新版本客户端，以查看内容' },
          ]],
          user_dsl: JSON.stringify({
            schema: '2.0',
            header: { title: { tag: 'plain_text', content: '测试卡片标题' } },
            body: { elements: [{ tag: 'markdown', content: '这是卡片里的**重要内容**' }] },
          }),
        }),
      },
    })
    const text = parseMessageEvent(ev).text
    expect(text).toContain('这是卡片里的**重要内容**')
    expect(text).toContain('测试卡片标题')
    expect(text).not.toContain('请升级至最新版本客户端')
  })

  it('preserves a real topic-thread message text alongside thread_id', () => {
    // A new-topic message in a topic group carries thread_id and the full
    // user text — the bot must receive the text, not an empty placeholder.
    const ev = textEvent({
      message: {
        ...textEvent().message!,
        chat_type: 'group',
        thread_id: 'omt_topic_1',
        content: JSON.stringify({ text: '创建话题: 帮我排查这个 bug' }),
      },
    })
    const ctx = parseMessageEvent(ev)
    expect(ctx.threadId).toBe('omt_topic_1')
    expect(ctx.text).toBe('创建话题: 帮我排查这个 bug')
  })
})

describe('resolveMentions', () => {
  it('replaces mention keys with names', () => {
    const out = resolveMentions('see @at_x', [{ key: 'at_x', id: { open_id: 'ou' }, name: 'Bob' }])
    expect(out).toBe('see @Bob')
  })
})
