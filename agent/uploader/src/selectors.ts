/**
 * Селекторы Pinterest в одном месте. Pinterest меняет разметку, поэтому для каждого элемента — несколько вариантов
 * (по атрибутам, по тексту кнопок на английском). Первый живой прогон уточняет этот файл; адрес массовой загрузки
 * можно переопределить в настройках портала (bulkUrl) без обновления агента.
 */
export const PINTEREST = {
  home: "https://www.pinterest.com/",
  settings: "https://www.pinterest.com/settings/",
  /** Страница массовой загрузки (проверено 2026-10-24): Settings → Import content → Bulk create Pins, блок «Upload .csv file».
   *  Страница /pin-creation-tool/ — создание ОДНОГО пина с картинкой, CSV туда класть нельзя (ответ «wrong format»). */
  bulkUrls: [
    "https://www.pinterest.com/settings/bulk-create-pins/",
  ],
  /** Признаки «не вошли» */
  loginUrl: /\/login\/?(\?|$)/i,
  loginButtons: ['button:has-text("Log in")', 'a:has-text("Log in")', '[data-test-id="login-button"]', '[data-test-id="simple-login-button"]'],
  /** Признаки «вошли» */
  loggedIn: ['[data-test-id="header-profile"]', '[data-test-id="profile-avatar"]', 'a[href*="/settings/"]', '[data-test-id="header-create-button"]'],
  /** Имя пользователя на странице настроек */
  usernameInput: ['input[name="username"]', '#username', 'input[id*="username"]'],
  /** Кнопки/ссылки «Bulk create» на странице создания */
  bulkEntry: ['a[href*="bulk-create-pins"]', 'a:has-text("Import content")', 'a:has-text("Bulk create")', 'button:has-text("Bulk create")'],
  /** Поле выбора CSV: только такое, что принимает csv/текст; поле для картинок/видео не подходит никогда.
   *  Если accept не задан — первое поле файла внутри блока с текстом «csv». */
  fileInput: ['input[type="file"][accept*="csv"]', 'input[type="file"][accept*="text"]', 'input[type="file"]:not([accept*="image"]):not([accept*="video"]):not([accept*="mp4"]):not([accept*="jpg"]):not([accept*="png"])'],
  /** Текст рядом с нужным полем — проверка, что мы на блоке CSV, а не TXT */
  csvBlockText: /upload \.csv file|\.csv file/i,
  /** Кнопка отправки после выбора файла (если она есть) */
  /** На странице bulk-create-pins CSV уходит сразу после выбора файла; кнопка «Import» там относится к блоку TXT — не трогаем.
   *  Нажимаем только явную кнопку отправки CSV, если она появится; «Create» в шапке — навигация, её тут нет намеренно. */
  submit: ['button:has-text("Upload csv")', 'button:has-text("Upload .csv")', 'button:has-text("Submit")'],
  /** Тексты успеха / ошибки после загрузки */
  success: /uploaded|processing|in progress|will be (published|created)|queued|received|success|being created|complete|imported|we.ll (create|publish)|scheduled/i,
  failure: /error|invalid|failed|wrong format|couldn.t|could not|unable|not supported|too many|limit|try again/i,
  /** Вход в историю загрузок */
  historyEntry: ['a:has-text("History")', 'button:has-text("History")', 'a:has-text("Upload history")', 'a:has-text("Bulk upload history")', '[data-test-id*="history"]', 'a[href*="history"]'],
  historyRows: ['table tr', '[role="row"]', '[data-test-id*="history"] li'],
  historyPublished: /(\d+)\s*(?:pins?\s*)?(published|created|succeeded|successful|complete)/i,
  historyFailed: /(\d+)\s*(?:pins?\s*)?(failed|errors?|rejected)/i,
  historyProcessing: /processing|in progress|pending|queued|validating/i,
};
