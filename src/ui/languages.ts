export interface LanguageOption {
  code: string;
  label: string;
}

export const sourceLanguageOptions: LanguageOption[] = [
  { code: 'auto', label: '自动检测' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
  { code: 'zh-TW', label: '繁体中文' },
  { code: 'it', label: '意大利语' },
  { code: 'pt', label: '葡萄牙语' },
];

export const targetLanguageOptions: LanguageOption[] = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
  { code: 'zh-TW', label: '繁体中文' },
  { code: 'it', label: '意大利语' },
  { code: 'pt', label: '葡萄牙语' },
];

export function getLanguageLabel(code: string): string {
  const found = sourceLanguageOptions.find((opt) => opt.code === code);
  return found ? found.label : code;
}
