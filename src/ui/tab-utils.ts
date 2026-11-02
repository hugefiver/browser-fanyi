export const unsupportedUrlPrefixes = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'moz-extension://',
  'devtools://',
  'view-source:',
];

export function isUnsupportedTabUrl(url: string | undefined): boolean {
  if (!url) return false;
  return unsupportedUrlPrefixes.some((prefix) => url.startsWith(prefix));
}
