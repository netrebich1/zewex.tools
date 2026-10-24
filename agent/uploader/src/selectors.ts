/**
 * Селекторы Pinterest в одном месте. Pinterest меняет разметку, поэтому для каждого элемента — несколько вариантов
 * (по атрибутам, по тексту кнопок на английском). Первый живой прогон уточняет этот файл; адрес массовой загрузки
 * можно переопределить в настройках портала (bulkUrl) без обновления агента.
 */
export const PINTEREST = {
  home: "https://www.pinterest.com/",
  settings: "https://www.pinterest.com/settings/",
  /** Кандидаты адресов страницы массовой загрузки (первый отвечающий без редиректа на логин) */
  bulkUrls: [
    "https://www.pinterest.com/pin-creation-tool/bulk/",
    "https://www.pinterest.com/business/bulk-pin-creation/",
    "https://www.pinterest.com/pin-creation-tool/",
  ],
  /** Признаки «не вошли» */
  loginUrl: /\/login\/?(\?|$)/i,
  loginButtons: ['button:has-text("Log in")', 'a:has-text("Log in")', '[data-test-id="login-button"]', '[data-test-id="simple-login-button"]'],
  /** Признаки «вошли» */
  loggedIn: ['[data-test-id="header-profile"]', '[data-test-id="profile-avatar"]', 'a[href*="/settings/"]', '[data-test-id="header-create-button"]'],
  /** Имя пользователя на странице настроек */
  usernameInput: ['input[name="username"]', '#username', 'input[id*="username"]'],
  /** Кнопки/ссылки «Bulk create» на странице создания */
  bulkEntry: ['a:has-text("Bulk create")', 'button:has-text("Bulk create")', 'a:has-text("Create Pins in bulk")', 'button:has-text("Create Pins in bulk")', '[data-test-id*="bulk"]', 'a[href*="bulk"]'],
  /** Поле выбора файла */
  fileInput: ['input[type="file"][accept*="csv"]', 'input[type="file"][accept*="text"]', 'input[type="file"]'],
  /** Кнопка отправки после выбора файла (если она есть) */
  submit: ['button:has-text("Upload")', 'button:has-text("Publish")', 'button:has-text("Create")', 'button:has-text("Submit")', 'button[type="submit"]'],
  /** Тексты успеха / ошибки после загрузки */
  success: /uploaded|processing|in progress|will be (published|created)|queued|received|success|being created|complete/i,
  failure: /error|invalid|failed|couldn.t|could not|unable|not supported|too many|limit|try again/i,
  /** Вход в историю загрузок */
  historyEntry: ['a:has-text("History")', 'button:has-text("History")', 'a:has-text("Upload history")', 'a:has-text("Bulk upload history")', '[data-test-id*="history"]', 'a[href*="history"]'],
  historyRows: ['table tr', '[role="row"]', '[data-test-id*="history"] li'],
  historyPublished: /(\d+)\s*(?:pins?\s*)?(published|created|succeeded|successful|complete)/i,
  historyFailed: /(\d+)\s*(?:pins?\s*)?(failed|errors?|rejected)/i,
  historyProcessing: /processing|in progress|pending|queued|validating/i,
};
