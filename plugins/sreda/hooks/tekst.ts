// Слова пользователя без служебных вставок приложения.
//
// 28–30.10 «Продолжай» в глобальной сессии не снимал паузу: приложение ставит перед сообщением пользователя
// вставку <system-reminder> («Linked sessions now: …»), и текст в prompt.submit и turn.start начинается с неё, а не с
// его слов. Проверки «в начале сообщения» (пауза, уровень усилий) смотрят текст без таких вставок.

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export function ownText(text: string): string {
  return text.replace(REMINDER, '').trim()
}
