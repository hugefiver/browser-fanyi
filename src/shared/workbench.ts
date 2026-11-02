import type { InputAssistCapture, InputAssistResult } from '../content/input-assist';
import type { PageStatus, PublicSettings, Reply } from './contracts';

export const WORKBENCH_PORT_NAME = 'workbench';
export const writingOperations = ['translate', 'polish', 'correct', 'shorten'] as const;
export type WritingOperation = typeof writingOperations[number];
export const operationLabels: Record<WritingOperation, string> = {
  translate: '翻译', polish: '润色', correct: '纠错', shorten: '精简',
};
export interface WorkbenchContext { contextId: string; settings: PublicSettings }
export type WorkbenchClientMessage =
  | { type: 'translate'; id: string; contextId: string; text: string; operation: WritingOperation }
  | { type: 'cancel'; id: string }
  | { type: 'apply'; id: string; contextId: string; text: string }
  | { type: 'restore'; id: string; contextId: string }
  | { type: 'page.status'; id: string; contextId: string }
  | { type: 'page.command'; id: string; contextId: string; tabId: number; action: 'start' | 'pause' | 'restore' };
export type WorkbenchServerMessage =
  | { type: 'hello'; context: WorkbenchContext; capture?: InputAssistCapture }
  | { type: 'invalidated'; context: WorkbenchContext }
  | { type: 'result'; id: string; contextId: string; reply: Reply<string> }
  | { type: 'input-result'; id: string; contextId: string; reply: InputAssistResult }
  | { type: 'page'; id: string; contextId: string; tabId?: number; reply: Reply<PageStatus> };
export type InputAssistCommand =
  | { type: 'input.capture' }
  | { type: 'input.apply'; instanceId: string; id: string; text: string }
  | { type: 'input.restore'; instanceId: string; id: string }
  | { type: 'input.invalidate'; instanceId: string; id: string };

export function workbenchMessage(value: unknown): value is WorkbenchClientMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id)) return false;
  if (message.type === 'cancel') return true;
  if (typeof message.contextId !== 'string') return false;
  if (message.type === 'restore' || message.type === 'page.status') return true;
  if (message.type === 'page.command') return Number.isSafeInteger(message.tabId)
    && ['start', 'pause', 'restore'].includes(String(message.action));
  if (typeof message.text !== 'string') return false;
  if (message.type === 'apply') return Array.from(message.text).length <= 20_000;
  return message.type === 'translate' && writingOperations.includes(message.operation as WritingOperation)
    && !!message.text.trim() && Array.from(message.text).length <= 2000;
}

export function inputCommand(value: unknown): value is InputAssistCommand {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'input.capture') return true;
  return ['input.apply', 'input.restore', 'input.invalidate'].includes(String(message.type))
    && typeof message.instanceId === 'string' && typeof message.id === 'string'
    && (message.type !== 'input.apply' || typeof message.text === 'string' && Array.from(message.text).length <= 20_000);
}

export const inputFailureText: Record<string, string> = {
  'not-found': '源输入框已不可用，请回原页重新捕获。', invalidated: '源绑定已失效，请重新捕获。',
  'cannot-apply': '此字段不能安全写回，可复制预览内容。', composing: '源字段正在输入法合成，请结束输入后重试。',
  'target-changed': '源字段已移除或变为不可写，未写入。', 'document-changed': '源文档已变化，未写入。',
  'url-changed': '源页面已导航，未写入。', 'value-changed': '源内容已变化，保留您的草稿。',
  'selection-changed': '源选区已变化，请重新捕获。', 'site-rejected': '页面未接受写入，请检查源字段。',
  'not-applied': '尚未写入，无需恢复。', 'user-changed': '写入后您已改稿，拒绝覆盖；可复制原文。',
};
