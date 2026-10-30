export type Option = { label: string; desc?: string }
export type Pending = {
  id: string
  from: string
  question: string
  why?: string
  options: Option[]
  // Можно выбрать несколько вариантов (окно с multiSelect): кнопки панели — флажки, ответ — кнопкой «Ответить»
  multi?: true
  // Команда, которую пользователь запускает сам (блок ``` в тексте вопроса или в preview варианта): панель
  // показывает её блоком кода (копируется его собственным значком)
  command?: string
  // Где запускать команду (строка «Где запускать: …» окна): панель показывает её перед блоком команды
  where?: string
  // Когда окно вопроса закрылось сообщением пользователя без ответа: вопрос ждёт в панели, а Claude задаст его снова
  missed?: string
  status?: 'open' | 'answered'
  answer?: string
  // Отмеченные варианты вопроса с несколькими ответами — окну они уходят списком, как из самого окна
  picked?: string[]
  asked?: string
  answeredAt?: string
  // Сессия, в которой открыто окно вопроса (вопрос записал сам плагин)
  session?: string
  // Сессия, в которой ответили
  answeredIn?: string
}

declare module 'claude-code' {
  interface PluginState {
    // picked — отмеченные в панели флажки: id вопроса → варианты
    // uroven — ручной режим этой сессии и уровень, выбранный в программе (hooks/uroven.ts): переживают перезагрузку
    // urovenRuchnoj — полоса ручного режима с кнопкой «Авто»: уровень из программы; null — режим авто, полосы нет
    sreda: {
      items: Pending[]
      picked: Record<string, string[]>
      uroven: { isSession: boolean; picked: string | number | null }
      urovenRuchnoj: string | null
    }
  }
}
