export type Option = { label: string; desc?: string }
export type Pending = {
  id: string
  from: string
  question: string
  why?: string
  options: Option[]
  status?: 'open' | 'answered'
  answer?: string
  asked?: string
  answeredAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    'zhdut-otveta': { items: Pending[] }
  }
}
