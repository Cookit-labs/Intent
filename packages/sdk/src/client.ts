export interface IntentClientConfig {
  apiUrl: string
  wsUrl: string
  authToken?: string
}

export class IntentClient {
  private readonly config: IntentClientConfig

  constructor(config: IntentClientConfig) {
    this.config = config
  }

  // TODO: implement request helper
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.authToken ? { Authorization: `Bearer ${this.config.authToken}` } : {}),
        ...options?.headers,
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  get intents() {
    return {
      // TODO: implement
      list: () => this.request('/v1/intents'),
      get: (id: string) => this.request(`/v1/intents/${id}`),
      create: (body: unknown) =>
        this.request('/v1/intents', { method: 'POST', body: JSON.stringify(body) }),
    }
  }

  get competitions() {
    return {
      // TODO: implement
      list: () => this.request('/v1/competitions'),
      get: (id: string) => this.request(`/v1/competitions/${id}`),
    }
  }

  get agents() {
    return {
      // TODO: implement
      list: () => this.request('/v1/agents'),
      get: (id: string) => this.request(`/v1/agents/${id}`),
    }
  }

  get leaderboard() {
    return {
      // TODO: implement
      get: () => this.request('/v1/leaderboard'),
    }
  }
}