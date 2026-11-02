import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = {
  manifest_version: 3,
  name: '网页译读',
  version: '0.1.0',
  description: '主动翻译当前网页和选区，支持双语、仅译文与还原。',
  permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'clipboardWrite', 'webNavigation'],
  optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  action: { default_popup: 'popup.html', default_title: '网页译读' },
  options_ui: { page: 'options.html', open_in_tab: true },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
};
for (const platform of ['chromium', 'firefox']) {
  const outDir = resolve(root, 'dist', platform);
  await mkdir(outDir, { recursive: true });
  await build({
    configFile: false, root, base: './', publicDir: false,
    build: { outDir, emptyOutDir: true, target: 'es2022',
      rollupOptions: {
        input: { popup: resolve(root, 'popup.html'), options: resolve(root, 'options.html'), selection: resolve(root, 'selection.html') },
        onwarn(warning, warn) {
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) return;
          warn(warning);
        },
      },
    },
  });
  for (const [name, entry] of [['background', `src/background/${platform}.ts`], ['content', 'src/content/index.ts']]) {
    await build({
      configFile: false, root, publicDir: false,
      build: { outDir, emptyOutDir: false, target: 'es2022',
        lib: { entry: resolve(root, entry), name: `Fanyi_${name}`, formats: ['iife'], fileName: () => `${name}.js` },
      },
    });
  }
  const manifest = platform === 'chromium'
    ? { ...base, minimum_chrome_version: '120', background: { service_worker: 'background.js' } }
    : { ...base, background: { scripts: ['background.js'], persistent: false }, browser_specific_settings: {
      gecko: { id: 'web-reader@browser-fanyi.local', strict_min_version: '140.0',
        data_collection_permissions: { required: ['websiteContent', 'authenticationInfo'] } },
    } };
  await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
