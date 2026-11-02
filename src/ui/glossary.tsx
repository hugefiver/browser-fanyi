import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import browser from '../shared/browser';
import type { GlossaryDraft, GlossaryEntry, Reply, UiRequest } from '../shared/contracts';
import { targetLanguageOptions } from './languages';

export const MAX_GLOSSARY_IMPORT_BYTES = 1024 * 1024;
const MAX_GLOSSARY_ENTRIES = 200;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseGlossaryImport(text: string, byteLength: number): GlossaryDraft[] {
  if (byteLength > MAX_GLOSSARY_IMPORT_BYTES) throw new Error('导入文件不能超过 1 MiB。');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('导入文件不是有效 JSON。'); }
  if (!record(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error('导入文件必须使用 version 1 术语格式。');
  }
  if (value.entries.length === 0 || value.entries.length > MAX_GLOSSARY_ENTRIES) {
    throw new Error(`导入文件须包含 1–${MAX_GLOSSARY_ENTRIES} 项术语。`);
  }
  const seen = new Set<string>();
  return value.entries.map((item, index) => {
    const position = index + 1;
    if (!record(item) || typeof item.source !== 'string' || typeof item.target !== 'string'
      || typeof item.targetLanguage !== 'string' || item.id !== undefined) {
      throw new Error(`第 ${position} 项必须包含 source、target 和 targetLanguage 字符串。`);
    }
    const source = item.source.trim();
    const target = item.target.trim();
    const targetLanguage = item.targetLanguage.trim();
    if (!source || Array.from(source).length > 80) throw new Error(`第 ${position} 项原词须为 1–80 个字符。`);
    if (!target || Array.from(target).length > 160) throw new Error(`第 ${position} 项译词须为 1–160 个字符。`);
    if (!targetLanguage) throw new Error(`第 ${position} 项目标语言不能为空。`);
    if ([source, target, targetLanguage].some((field) => CONTROL_CHARACTER.test(field))) {
      throw new Error(`第 ${position} 项字段须为不含控制字符的单行文本。`);
    }
    const duplicateKey = JSON.stringify([targetLanguage, source]);
    if (seen.has(duplicateKey)) throw new Error(`第 ${position} 项与本批较早术语重复。`);
    seen.add(duplicateKey);
    return { source, target, targetLanguage };
  });
}

async function send<T>(message: UiRequest): Promise<T> {
  const reply = await browser.runtime.sendMessage(message) as Reply<T>;
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.value;
}

interface GlossaryPanelProps { reloadKey: number }

type Notice = { severity: 'success' | 'info' | 'error'; text: string };

export const GlossaryPanel: React.FC<GlossaryPanelProps> = ({ reloadKey }) => {
  const [entries, setEntries] = useState<GlossaryEntry[] | null>(null);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('zh-CN');
  const [editingId, setEditingId] = useState<string>();
  const [pendingImport, setPendingImport] = useState<GlossaryDraft[]>();
  const [importName, setImportName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  useEffect(() => {
    let active = true;
    void send<GlossaryEntry[]>({ type: 'glossary.list' }).then((value) => {
      if (active) setEntries(value);
    }).catch((error: unknown) => {
      if (active) setNotice({ severity: 'error', text: error instanceof Error ? error.message : '读取术语失败。' });
    });
    return () => { active = false; };
  }, [reloadKey]);

  const resetForm = () => {
    setSource('');
    setTarget('');
    setTargetLanguage('zh-CN');
    setEditingId(undefined);
  };

  const saveEntry = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const entry = { source, target, targetLanguage, ...(editingId ? { id: editingId } : {}) };
      setEntries(await send<GlossaryEntry[]>({ type: 'glossary.upsert', entry }));
      setNotice({ severity: 'success', text: editingId ? '术语已更新。' : '术语已添加。' });
      resetForm();
    } catch (error) {
      setNotice({ severity: 'error', text: error instanceof Error ? error.message : '保存术语失败。' });
    } finally { setBusy(false); }
  };

  const removeEntry = async (id: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      setEntries(await send<GlossaryEntry[]>({ type: 'glossary.delete', id }));
      if (editingId === id) resetForm();
      setNotice({ severity: 'success', text: '术语已删除。' });
    } catch (error) {
      setNotice({ severity: 'error', text: error instanceof Error ? error.message : '删除术语失败。' });
    } finally { setBusy(false); }
  };

  const chooseImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice(undefined);
    try {
      const drafts = parseGlossaryImport(await file.text(), file.size);
      const current = entries ?? [];
      if (current.length + drafts.length > MAX_GLOSSARY_ENTRIES) {
        throw new Error(`第 ${MAX_GLOSSARY_ENTRIES - current.length + 1} 项使术语总数超过 ${MAX_GLOSSARY_ENTRIES} 项。`);
      }
      const existing = new Set(current.map((entry) => JSON.stringify([entry.targetLanguage, entry.source])));
      const duplicateIndex = drafts.findIndex((draft) => existing.has(JSON.stringify([draft.targetLanguage, draft.source])));
      if (duplicateIndex >= 0) throw new Error(`第 ${duplicateIndex + 1} 项与已有术语重复。`);
      setPendingImport(drafts);
      setImportName(file.name);
      setNotice({ severity: 'info', text: `已校验 ${drafts.length} 项，请确认后追加。` });
    } catch (error) {
      setPendingImport(undefined);
      setImportName('');
      setNotice({ severity: 'error', text: error instanceof Error ? error.message : '读取导入文件失败。' });
    }
  };

  const confirmImport = async () => {
    if (!pendingImport) return;
    setBusy(true);
    setNotice(undefined);
    try {
      setEntries(await send<GlossaryEntry[]>({ type: 'glossary.import', entries: pendingImport }));
      setNotice({ severity: 'success', text: `已原子追加 ${pendingImport.length} 项术语。` });
      setPendingImport(undefined);
      setImportName('');
    } catch (error) {
      setNotice({ severity: 'error', text: error instanceof Error ? error.message : '导入术语失败。' });
    } finally { setBusy(false); }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
      <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600, mb: 1 }}>
        本地术语表
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        术语仅保存在本机。翻译时只把当前文本实际匹配的原词与译词发送给您配置的服务。
      </Typography>
      <Alert severity="warning" sx={{ mb: 2 }}>
        术语可能包含私有信息；匹配项会发送给当前服务，生成模型不保证遵从术语映射。
      </Alert>
      {notice && <Alert severity={notice.severity} onClose={() => setNotice(undefined)} sx={{ mb: 2 }}>{notice.text}</Alert>}

      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField
            fullWidth
            size="small"
            label="原词"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            helperText="1–80 个字符，大小写敏感"
          />
          <TextField
            fullWidth
            size="small"
            label="译词"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            helperText="1–160 个字符"
          />
          <TextField
            select
            fullWidth
            size="small"
            label="术语目标语言"
            value={targetLanguage}
            onChange={(event) => setTargetLanguage(event.target.value)}
          >
            {!targetLanguageOptions.some((option) => option.code === targetLanguage)
              && <MenuItem value={targetLanguage}>{targetLanguage}</MenuItem>}
            {targetLanguageOptions.map((option) => (
              <MenuItem key={option.code} value={option.code}>{option.label}</MenuItem>
            ))}
          </TextField>
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button
            variant="contained"
            onClick={() => void saveEntry()}
            disabled={busy || !source.trim() || !target.trim() || !targetLanguage.trim()}
          >
            {editingId ? '保存术语修改' : '添加术语'}
          </Button>
          {editingId && <Button onClick={resetForm} disabled={busy}>取消编辑</Button>}
        </Stack>

        <Divider />

        <Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
            <Button component="label" variant="outlined" disabled={busy || entries === null}>
              选择 version 1 JSON
              <input hidden type="file" accept="application/json,.json" aria-label="导入术语 JSON" onChange={(event) => void chooseImport(event)} />
            </Button>
            <Typography variant="caption" color="text.secondary">
              最多 1 MiB；确认后整批追加，任一错误都会拒绝整批且不会自动合并。
            </Typography>
          </Stack>
          {pendingImport && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mt: 1.5 }}>
              <Typography variant="body2">{importName}：{pendingImport.length} 项待追加</Typography>
              <Button variant="contained" onClick={() => void confirmImport()} disabled={busy}>
                确认导入 {pendingImport.length} 项
              </Button>
              <Button onClick={() => { setPendingImport(undefined); setImportName(''); }} disabled={busy}>取消导入</Button>
            </Stack>
          )}
        </Box>

        <Divider />

        <Typography variant="subtitle2">
          已保存术语 {entries?.length ?? 0} / {MAX_GLOSSARY_ENTRIES}
        </Typography>
        {entries === null ? (
          <Typography variant="body2" color="text.secondary">正在读取术语...</Typography>
        ) : entries.length === 0 ? (
          <Typography variant="body2" color="text.secondary">尚未添加术语。</Typography>
        ) : (
          <Stack divider={<Divider flexItem />}>
            {entries.map((entry) => (
              <Stack
                key={entry.id}
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                justifyContent="space-between"
                alignItems={{ sm: 'center' }}
                sx={{ py: 1 }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    <strong>{entry.source}</strong> → {entry.target}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">目标语言：{entry.targetLanguage}</Typography>
                </Box>
                <Stack direction="row" spacing={0.5}>
                  <Button size="small" disabled={busy} onClick={() => {
                    setSource(entry.source);
                    setTarget(entry.target);
                    setTargetLanguage(entry.targetLanguage);
                    setEditingId(entry.id);
                    setNotice(undefined);
                  }}>编辑</Button>
                  <Button size="small" color="error" disabled={busy} onClick={() => void removeEntry(entry.id)}>删除</Button>
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
};
