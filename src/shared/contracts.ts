export type DisplayMode = 'bilingual' | 'translation';
export type ErrorCode = 'configuration' | 'permission' | 'authentication' | 'quota' | 'rate-limit' | 'network' | 'timeout' | 'invalid-response' | 'interrupted' | 'unsupported' | 'limit' | 'glossary';
export interface Failure { code: ErrorCode; message: string }
export type Reply<T> = { ok: true; value: T } | { ok: false; error: Failure };
export interface Preferences { sourceLanguage: string; targetLanguage: string; mode: DisplayMode }
export interface PublicSettings extends Preferences { prefix: string; model: string; hasKey: boolean; authorized: boolean }
export interface SaveSettings extends Preferences { prefix: string; model: string; key: { kind: 'keep' | 'clear' } | { kind: 'replace'; value: string; forOrigin: string } }
export interface GlossaryDraft { source: string; target: string; targetLanguage: string }
export interface GlossaryEntry extends GlossaryDraft { id: string }
export interface GlossaryMapping { source: string; target: string }
export const defaultPreferences: Preferences = { sourceLanguage: 'auto', targetLanguage: 'zh-CN', mode: 'bilingual' };
export type PagePhase = 'idle' | 'running' | 'complete' | 'paused' | 'partial' | 'interrupted' | 'empty' | 'limit';
export interface PageStatus {
  phase: PagePhase; mode: DisplayMode; total: number; completed: number; failed: number; pending: number; hoverEnabled: boolean; error?: Failure;
}
export const idleStatus = (): PageStatus => ({ phase: 'idle', mode: 'bilingual', total: 0, completed: 0, failed: 0, pending: 0, hoverEnabled: false });
export type PageAction = 'start' | 'pause' | 'resume' | 'retry' | 'restore' | 'mode' | 'review';
export interface Grant { sessionId: string; preferences: Preferences }
export interface SelectionState { id: string; source: string; phase: 'running' | 'complete' | 'failed'; text?: string; error?: Failure }
export type UiRequest =
  | { type: 'settings.get' }
  | { type: 'settings.save'; settings: SaveSettings }
  | { type: 'settings.clear'; all: boolean }
  | { type: 'service.test' }
  | { type: 'sites.list' }
  | { type: 'sites.save'; tabId: number; rule: import('../background/site-rules').SiteRule }
  | { type: 'sites.change'; origin: string; action: 'enable' | 'disable' | 'remove' }
  | { type: 'glossary.list' }
  | { type: 'glossary.upsert'; entry: GlossaryDraft & { id?: string } }
  | { type: 'glossary.delete'; id: string }
  | { type: 'glossary.import'; entries: GlossaryDraft[] }
  | { type: 'page.command'; tabId: number; action: PageAction; mode?: DisplayMode }
  | { type: 'page.status'; tabId: number }
  | { type: 'hover.command'; tabId: number; enabled: boolean }
  | { type: 'selection.start'; tabId: number }
  | { type: 'input.start'; tabId: number }
  | { type: 'capture.start'; tabId: number }
  | { type: 'video.list'; tabId: number }
  | { type: 'video.command'; tabId: number; action: 'start'; videoIndex: number; trackIndex: number; mode: DisplayMode }
  | { type: 'video.command'; tabId: number; action: 'stop' | 'continue' }
  | { type: 'selection.get'; id: string }
  | { type: 'selection.retry'; id: string }
  | { type: 'selection.close'; id: string };
export type ContentRequest =
  | { type: 'content.translate'; sessionId: string; text: string }
  | { type: 'content.cancel'; sessionId: string }
  | { type: 'hover.translate'; sessionId: string; sequence: number; text: string }
  | { type: 'hover.cancel'; sessionId: string; sequence: number }
  | { type: 'video.translate'; sessionId: string; sequence: number; text: string }
  | { type: 'video.cancel'; sessionId: string; sequence: number }
  | { type: 'video.end'; sessionId: string };
export type ContentCommand =
  | { type: 'content.command'; action: PageAction; grant?: Grant; mode?: DisplayMode }
  | { type: 'hover.command'; enabled: boolean; grant?: Grant }
  | { type: 'content.status' }
  | { type: 'content.selection' }
  | { type: 'content.invalidate'; error: Failure };
export const errorMessages: Record<ErrorCode, string> = {
  configuration: '请先保存有效的服务地址和模型。', permission: '请在设置中授权所选服务主机。',
  authentication: '服务拒绝认证，请检查密钥。', quota: '服务额度不足，请检查账户额度。',
  'rate-limit': '服务限流，请稍后主动重试。', network: '无法连接服务，请检查网络和地址。',
  timeout: '服务请求超时，可主动重试。', 'invalid-response': '服务未返回完整有效的文本译文。',
  interrupted: '操作已中断，请主动重新开始。', unsupported: '无法访问此页面，请使用普通网页。', limit: '已达到本次发送限制，请缩小范围或主动继续。',
  glossary: '术语数据无效，请检查后重试。',
};
export const fail = (code: ErrorCode): Reply<never> => ({ ok: false, error: { code, message: errorMessages[code] } });
