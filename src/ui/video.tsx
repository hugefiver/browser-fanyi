import React, { useEffect, useState } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import browser from '../shared/browser';
import type { DisplayMode, PublicSettings, Reply, UiRequest } from '../shared/contracts';
import type { VideoInfo } from '../shared/video';

export function VideoPanel({ tabId, settings }: { tabId: number | null; settings: PublicSettings | null }) {
  const [info, setInfo] = useState<VideoInfo>();
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<DisplayMode>('bilingual');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setInfo(undefined); setSelected(''); }, [tabId]);
  const run = async (message: UiRequest) => {
    setBusy(true); setError('');
    try {
      const reply = await browser.runtime.sendMessage(message) as Reply<VideoInfo>;
      if (!reply.ok) { setError(reply.error.message); return; }
      setInfo(reply.value);
      setSelected(current => reply.value.videos.some(video => video.tracks.some(track =>
        track.choiceId === current && track.readable && track.cues.length > 0)) ? current : '');
      if (reply.value.state.error) setError(reply.value.state.error);
    } catch { setError('无法读取当前页的可读视频字幕。'); }
    finally { setBusy(false); }
  };
  const tracks = info?.videos.flatMap(video => video.tracks.filter(track => track.readable && track.cues.length > 0)
    .map(track => ({ value: track.choiceId,
      label: `视频 ${video.videoIndex + 1} · ${track.label || track.language || `轨道 ${track.trackIndex + 1}`} · ${track.cues.length} 条` }))) ?? [];
  return <Stack spacing={1} component="section" aria-label="可读视频字幕">
    <Typography variant="h6">可读视频字幕</Typography>
    <Button disabled={tabId === null || busy} onClick={() => void run({ type: 'video.list', tabId: tabId! })}>读取文字轨 / 刷新字幕状态</Button>
    {info && !tracks.length && <Alert severity="info">当前没有可读字幕 cue。只支持 video.textTracks；不读取音频、不抓取私有播放器资源。</Alert>}
    {!!tracks.length && <>
      <TextField select label="视频与字幕轨" value={selected} onChange={event => setSelected(event.target.value)}>
        {tracks.map(track => <MenuItem key={track.value} value={track.value}>{track.label}</MenuItem>)}
      </TextField>
      <TextField select label="字幕显示" value={mode} onChange={event => setMode(event.target.value as DisplayMode)}>
        <MenuItem value="bilingual">双语</MenuItem><MenuItem value="translation">仅译文</MenuItem>
      </TextField>
      <Typography variant="caption">本次播放期间，仅当前字幕发送给 {settings?.prefix || '未配置服务'}，模型 {settings?.model || '未配置'}，可能产生费用。每轮最多 100 请求；列表跳转不自动播放。关闭或导航结束同意。</Typography>
      <Button disabled={busy || !tracks.some(track => track.value === selected) || !settings?.authorized || !settings.model} onClick={() => {
        void run({ type: 'video.command', action: 'start', tabId: tabId!, choiceId: selected, mode });
      }}>同意本次播放发送并开启字幕翻译</Button>
    </>}
    {info && <>
      <Typography role="status">本轮请求：{info.state.requestsUsed} / 100</Typography>
      <Button disabled={busy || !info.state.canContinue} onClick={() => void run({ type: 'video.command', tabId: tabId!, action: 'continue' })}>确认继续下一轮字幕</Button>
      <Button disabled={busy} onClick={() => void run({ type: 'video.command', tabId: tabId!, action: 'stop' })}>关闭视频字幕翻译</Button>
    </>}
    {error && <Alert severity="error">{error}</Alert>}
  </Stack>;
}
