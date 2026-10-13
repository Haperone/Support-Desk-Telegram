export const DEFAULT_LANGUAGE = 'en';

export const LANGUAGES = Object.freeze({
  en: { name: 'English', button: '🇬🇧 English', dateLocale: 'en-GB' },
  ru: { name: 'Русский', button: '🇷🇺 Русский', dateLocale: 'ru-RU' },
  es: { name: 'Español', button: '🇪🇸 Español', dateLocale: 'es-ES' },
  zh: { name: '简体中文', button: '🇨🇳 简体中文', dateLocale: 'zh-CN' },
});

export function supportedLanguage(value) {
  return typeof value === 'string' && Object.hasOwn(LANGUAGES, value);
}

export function languageOrDefault(value) {
  return supportedLanguage(value) ? value : DEFAULT_LANGUAGE;
}
