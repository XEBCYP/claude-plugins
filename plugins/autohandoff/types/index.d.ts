// Полоса над полем ввода: отсчёт до автопередачи, пауза
export type Band = {
  // Секунд до передачи
  left: number
  isPaused: boolean
  // Контекст, тыс. токенов
  ctx: number
  // Верхний порог пройден: передача без проверки момента
  isDue: boolean
  // Передачу попросила сама сессия (инструмент `peredat`)
  isAsked?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    autohandoff: { band: Band | null }
  }
}
