import type { AnyWSEvent, WSEventType } from '@intent/types'

type EventHandler<T extends AnyWSEvent> = (event: T) => void

export class IntentWebSocket {
  private ws: WebSocket | null = null
  private readonly url: string
  private readonly handlers = new Map<WSEventType, Set<EventHandler<AnyWSEvent>>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0

  constructor(url: string) {
    this.url = url
  }

  connect(): void {
    // TODO: implement with auto-reconnect
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  on<T extends AnyWSEvent>(type: WSEventType, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler as EventHandler<AnyWSEvent>)
    return () => this.handlers.get(type)?.delete(handler as EventHandler<AnyWSEvent>)
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}