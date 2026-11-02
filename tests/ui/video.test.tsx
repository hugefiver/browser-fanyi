import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicSettings, Reply, UiRequest } from '../../src/shared/contracts';
import type { VideoInfo } from '../../src/shared/video';

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn<(message: UiRequest) => Promise<Reply<VideoInfo>>>() }));
vi.mock('../../src/shared/browser', () => ({ default: { runtime: mocks } }));
import { VideoPanel } from '../../src/ui/video';

const settings: PublicSettings = {
  prefix: 'https://receiver.example/v1', model: 'test', hasKey: true, authorized: true,
  sourceLanguage: 'auto', targetLanguage: 'zh-CN', mode: 'bilingual',
};
const refresh = '读取文字轨 / 刷新字幕状态';
const start = '同意本次播放发送并开启字幕翻译';

function info(...choices: string[]): VideoInfo {
  return {
    videos: [{ videoIndex: 0, currentTime: 0, duration: 20,
      tracks: choices.map((choiceId, trackIndex) => ({
        choiceId, trackIndex, id: `track-${trackIndex}`, kind: 'subtitles',
        label: `字幕 ${trackIndex + 1}`, language: 'en', mode: 'hidden', readable: true,
        cues: [{ index: 0, startTime: 0, endTime: 10, text: 'Readable cue' }],
      })),
    }],
    state: { phase: 'active', mode: 'bilingual', requestsUsed: 0, requestsRemaining: 100, canContinue: true, cues: [] },
  };
}

async function click(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
}

async function choose(name: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '视频与字幕轨' }));
  fireEvent.click(await screen.findByRole('option', { name }));
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

afterEach(() => { cleanup(); mocks.sendMessage.mockReset(); });

describe('VideoPanel explicit track selection', () => {
  it.each([
    ['inspect', refresh],
    ['start', start],
    ['stop', '关闭视频字幕翻译'],
    ['continue', '确认继续下一轮字幕'],
  ])('clears a stale choice after %s and requires reselection before starting', async (action, button) => {
    mocks.sendMessage.mockResolvedValue({ ok: true, value: info('old-1', 'old-2') });
    render(<VideoPanel tabId={1} settings={settings} />);
    await click(refresh);
    expect(screen.getByRole('button', { name: start }).hasAttribute('disabled')).toBe(true);
    await choose('视频 1 · 字幕 2 · 1 条');
    expect(screen.getByRole('button', { name: start }).hasAttribute('disabled')).toBe(false);

    mocks.sendMessage.mockResolvedValue({ ok: true, value: info('new-1', 'new-2') });
    await click(button);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(action === 'inspect'
      ? { type: 'video.list', tabId: 1 }
      : expect.objectContaining({ type: 'video.command', action, tabId: 1 }));
    expect(screen.getByRole('combobox', { name: '视频与字幕轨' }).textContent).not.toContain('字幕 2');
    expect(screen.getByRole('button', { name: start }).hasAttribute('disabled')).toBe(true);
    const calls = mocks.sendMessage.mock.calls.length;
    await click(start);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(calls);

    await choose('视频 1 · 字幕 2 · 1 条');
    expect(screen.getByRole('button', { name: start }).hasAttribute('disabled')).toBe(false);
    await click(start);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith({
      type: 'video.command', action: 'start', tabId: 1, choiceId: 'new-2', mode: 'bilingual',
    });
  });

  it('preserves an explicit selection that still belongs to the refreshed choices', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, value: info('choice-1', 'choice-2') });
    render(<VideoPanel tabId={1} settings={settings} />);
    await click(refresh);
    await choose('视频 1 · 字幕 2 · 1 条');
    await click(refresh);
    expect(screen.getByRole('button', { name: start }).hasAttribute('disabled')).toBe(false);
    await click(start);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith({
      type: 'video.command', action: 'start', tabId: 1, choiceId: 'choice-2', mode: 'bilingual',
    });
  });
});
