import { randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Access } from '../shared/types'
import type { Engine } from './room/engine'
import type { Store } from './store'

type Hooks = {
  emit(channel: string, payload: unknown): void
  defaults(): { crew: string[]; workspace: string }
}

type Msg = { message_id: number; chat: { id: number; type?: string; first_name?: string; username?: string }; text?: string }
type Update = { update_id: number; message?: Msg; callback_query?: { id: string; data?: string; message?: Msg } }

export type RemoteStatus = { on: boolean; token: boolean; paired: boolean; name?: string; bot?: string; code: string; error?: string }

const LIMIT = 3800
const clip = (s: string) => (s.length > LIMIT ? s.slice(0, LIMIT).replace(/\s+\S*$/, '') + ' …' : s)

// Lunchbox from a phone, through a Telegram bot the person makes with @BotFather. Only the one
// chat that sent the pairing code shown in Settings is listened to; everything else is ignored.
export class Remote {
  private running = false
  private abort: AbortController | null = null
  private offset = 0
  private room: string | null = null
  private code = String(randomInt(100000, 999999))
  private tries = 0
  private bot = ''
  private error = ''

  constructor(private store: Store, private engine: Engine, private hooks: Hooks) {}

  private get token() { return this.store.keys().telegram ?? '' }
  private get conf() { return this.store.settings.remote ?? { on: false } }

  status(): RemoteStatus {
    return { on: this.conf.on, token: !!this.token, paired: !!this.conf.chat, name: this.conf.name, bot: this.bot || undefined, code: this.code, error: this.error || undefined }
  }

  private changed() {
    this.hooks.emit('remote', this.status())
  }

  private async api<T = unknown>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string }
    if (!json.ok) throw new Error(json.description || `Telegram answered ${res.status}`)
    return json.result as T
  }

  async start() {
    this.stop()
    if (!this.conf.on || !this.token) return this.changed()
    try {
      const me = await this.api<{ username: string }>('getMe')
      this.bot = me.username
      this.error = ''
    } catch (e) {
      this.error = (e as Error).message
      return this.changed()
    }
    this.running = true
    this.offset = this.saved()
    this.changed()
    this.loop()
  }

  stop() {
    this.running = false
    this.abort?.abort()
    this.abort = null
  }

  unpair() {
    this.store.saveSettings({ remote: { on: this.conf.on, access: this.conf.access } })
    this.code = String(randomInt(100000, 999999))
    this.tries = 0
    this.changed()
  }

  // Telegram only forgets an update once the next poll passes its offset, so the offset is kept on
  // disk: a restart would otherwise run the last message from the phone a second time. It is
  // kept per bot, since update numbers mean nothing to a different one.
  private get offsetFile() { return join(this.store.dir, 'telegram-offset.json') }
  private saved() {
    try {
      const o = JSON.parse(readFileSync(this.offsetFile, 'utf8'))
      return o.bot === this.token.split(':')[0] && Number.isInteger(o.offset) ? o.offset : 0
    } catch {
      return 0
    }
  }

  private async loop() {
    while (this.running) {
      this.abort = new AbortController()
      try {
        const updates = await this.api<Update[]>('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, this.abort.signal)
        if (this.error) { this.error = ''; this.changed() }
        for (const u of updates) {
          this.offset = u.update_id + 1
          // Saved before handling: a crash halfway should drop the message, not repeat it.
          try { writeFileSync(this.offsetFile, JSON.stringify({ bot: this.token.split(':')[0], offset: this.offset })) } catch {}
          await this.handle(u).catch((e) => this.reply(u.message?.chat.id ?? u.callback_query?.message?.chat.id, `Something broke: ${(e as Error).message}`))
        }
      } catch (e) {
        if (!this.running) return
        this.error = (e as Error).message
        this.changed()
        await new Promise((r) => setTimeout(r, 8000))
      }
    }
  }

  private reply(chat: number | undefined, text: string, buttons?: { text: string; data: string }[][]) {
    if (!chat) return Promise.resolve()
    return this.api('sendMessage', {
      chat_id: chat, text: clip(text), disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
    }).catch(() => {})
  }

  private current() {
    const rooms = this.engine.summaries()
    if (this.room && rooms.some((r) => r.id === this.room)) return this.room
    return (this.room = rooms[0]?.id ?? null)
  }

  private get access(): Access { return this.conf.access ?? 'workspace' }

  private async handle(u: Update) {
    if (u.callback_query) {
      const q = u.callback_query
      if (!q.message || !this.conf.chat || q.message.chat.id !== this.conf.chat) return
      const [kind, room, ref, i] = (q.data ?? '').split(':')
      if (kind === 'd') this.engine.decide(room, ref, Number(i), this.access)
      if (kind === 'r') { this.room = room; await this.reply(this.conf.chat, `Now talking to “${this.store.room(room)?.name ?? 'that room'}”.`) }
      await this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {})
      return
    }
    const m = u.message
    if (!m?.text) return
    const text = m.text.trim()
    if (!this.conf.chat) {
      // Only a private chat can pair, so a group the bot sits in never gets control.
      if (m.chat.type && m.chat.type !== 'private') return
      // Six digits can be guessed; five wrong tries end pairing until a new code is made.
      if (this.tries >= 5) return
      if (text.replace(/^\/start\s*/, '') === this.code) {
        this.store.saveSettings({ remote: { ...this.conf, chat: m.chat.id, name: m.chat.first_name || m.chat.username } })
        this.changed()
        return this.reply(m.chat.id, 'Paired with Lunchbox. Write to talk to your latest room, /rooms to pick another, /new to start one, /stop to stop the work.')
      }
      if (/^\/start\s*\d|^\d{4,}$/.test(text)) this.tries++
      return this.reply(m.chat.id, this.tries >= 5 ? 'Too many wrong codes. Make a new one in Lunchbox, Settings, Phone.' : 'Send the six digit code shown in Lunchbox, Settings, Phone.')
    }
    if (m.chat.id !== this.conf.chat) return

    if (text === '/rooms' || text === '/start') {
      const rooms = this.engine.summaries().slice(0, 8)
      if (!rooms.length) return this.reply(m.chat.id, 'No rooms yet. Start one with /new and what you need.')
      return this.reply(m.chat.id, 'Pick a room:', rooms.map((r) => [{ text: `${r.id === this.current() ? '• ' : ''}${r.name}${r.waiting ? ' (needs you)' : r.busy ? ' (working)' : ''}`, data: `r:${r.id}` }]))
    }
    if (text === '/stop') {
      const room = this.current()
      if (room) this.engine.stop(room)
      return this.reply(m.chat.id, 'Stopped.')
    }
    if (text === '/status') {
      const room = this.current()
      if (!room) return this.reply(m.chat.id, 'No rooms yet.')
      const live = this.engine.live(room)
      return this.reply(m.chat.id, `${this.store.room(room)?.name}: ${live.waiting ? 'waiting for you' : live.doing || 'quiet'}`)
    }
    if (text.startsWith('/new')) {
      const goal = text.replace(/^\/new\s*/, '')
      if (!goal) return this.reply(m.chat.id, 'Say what the room is for, like /new find out what people think of our launch')
      const d = this.hooks.defaults()
      if (!d.crew.length) return this.reply(m.chat.id, 'No agent is ready on the computer.')
      mkdirSync(d.workspace, { recursive: true })
      const meta = this.engine.create({ crew: d.crew, workspace: d.workspace })
      this.room = meta.id
      this.engine.send(meta.id, goal, this.access, { from: 'phone' })
      return this.reply(m.chat.id, 'Started. I will write when it is done or needs you.')
    }
    const room = this.current()
    if (!room) return this.reply(m.chat.id, 'No rooms yet. Start one with /new and what you need.')
    this.engine.send(room, text, this.access, { from: 'phone' })
    return this.api('sendChatAction', { chat_id: m.chat.id, action: 'typing' }).catch(() => {})
  }

  // Called when a room finishes or needs the person: the last word, and any open decision as buttons.
  forward(room: string, body: string) {
    if (!this.running || !this.conf.chat) return
    const meta = this.store.room(room)
    if (!meta) return
    const events = this.store.events(room)
    const chosen = new Set(events.flatMap((e) => (e.kind === 'chose' ? [e.ref] : [])))
    const open = events.findLast((e) => e.kind === 'decide' && !chosen.has(e.id))
    if (open?.kind === 'decide') {
      return this.reply(this.conf.chat, `${meta.name}\n\n${open.text}`, [open.options.map((o, i) => ({ text: o.label, data: `d:${room}:${open.id}:${i}` }))])
    }
    const said = events.findLast((e) => e.kind === 'say' && !!e.text)
    const name = (id: string) => this.engine.agents.find((a) => a.id === id)?.short ?? id
    return this.reply(this.conf.chat, said?.kind === 'say' ? `${meta.name}, ${name(said.who)}:\n\n${said.text}` : `${meta.name}: ${body}`)
  }
}
