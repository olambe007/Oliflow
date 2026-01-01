
export interface TranslationRecord {
  id: string;
  originalText: string;
  translatedText: string;
  fromLang: string;
  toLang: string;
  timestamp: number;
}

export interface Language {
  code: string;
  name: string;
  flag: string;
  voice: string;
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'fr', name: 'Français', flag: '🇫🇷', voice: 'Kore' },
  { code: 'en', name: 'English', flag: '🇺🇸', voice: 'Puck' },
  { code: 'es', name: 'Español', flag: '🇪🇸', voice: 'Kore' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪', voice: 'Fenrir' },
  { code: 'it', name: 'Italiano', flag: '🇮🇹', voice: 'Kore' },
  { code: 'ja', name: '日本語', flag: '🇯🇵', voice: 'Kore' },
  { code: 'zh', name: '中文', flag: '🇨🇳', voice: 'Puck' },
  { code: 'th', name: 'Thaï', flag: '🇹🇭', voice: 'Kore' },
  { code: 'uk', name: 'Ukrainien', flag: '🇺🇦', voice: 'Kore' },
  { code: 'cs', name: 'Tchèque', flag: '🇨🇿', voice: 'Puck' },
  { code: 'pl', name: 'Polonais', flag: '🇵🇱', voice: 'Fenrir' },
];
