export interface TranslationReviewEntry {
  id: string;
  source: string;
  serviceTranslation: string;
  translation: string;
  edited: boolean;
  revealed: boolean;
}

export interface TranslationReviewCallbacks {
  getEntries(): readonly TranslationReviewEntry[];
  edit(id: string, text: string): void;
  reset(id: string): void;
  reveal(id: string, revealed: boolean): void;
  learning(enabled: boolean): void;
}

interface TranslationReviewUi {
  root: HTMLDivElement;
  learning: HTMLInputElement;
  summary: HTMLDivElement;
  list: HTMLOListElement;
  previous: HTMLButtonElement;
  page: HTMLSpanElement;
  next: HTMLButtonElement;
}

const pageSize = 50;

export class TranslationReview {
  private ui?: TranslationReviewUi;
  private entries: readonly TranslationReviewEntry[] = [];
  private pageIndex = 0;
  private learningEnabled = false;
  private drafts = new Map<string, string>();
  private destroyed = false;

  constructor(
    private readonly document: Document,
    private readonly callbacks: TranslationReviewCallbacks,
  ) {}

  open(): void {
    if (this.destroyed) throw new Error('TranslationReview has been destroyed.');
    if (!this.ui) this.ui = this.createUi();
    this.refresh();
  }

  refresh(force = false): void {
    if (!this.ui || this.destroyed) return;
    const entries = this.callbacks.getEntries();
    if (!force && entries.length === this.entries.length && entries.every((entry, index) => {
      const previous = this.entries[index];
      return entry.id === previous.id && entry.source === previous.source && entry.translation === previous.translation
        && entry.serviceTranslation === previous.serviceTranslation && entry.edited === previous.edited && entry.revealed === previous.revealed;
    }) && this.ui.list.childElementCount) return;
    this.entries = entries;
    for (const id of this.drafts.keys()) if (!entries.some(entry => entry.id === id)) this.drafts.delete(id);
    const lastPage = Math.max(0, Math.ceil(this.entries.length / pageSize) - 1);
    this.pageIndex = Math.min(this.pageIndex, lastPage);
    this.render();
  }

  close(): void {
    if (this.learningEnabled) {
      this.learningEnabled = false;
      this.callbacks.learning(false);
    }
    this.drafts.clear();
    this.ui?.root.remove();
    this.ui = undefined;
    this.entries = [];
    this.pageIndex = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.close();
    this.destroyed = true;
  }

  private createUi(): TranslationReviewUi {
    const root = this.document.createElement('div');
    root.setAttribute('data-browser-fanyi', 'translation-review');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '译文审查');
    root.setAttribute('aria-modal', 'false');
    Object.assign(root.style, {
      position: 'fixed',
      zIndex: '2147483647',
      insetInlineEnd: '8px',
      insetBlockStart: '8px',
      width: 'min(440px, calc(100vw - 16px))',
      maxHeight: 'calc(100vh - 16px)',
      overflow: 'auto',
      padding: '12px',
      color: 'CanvasText',
      background: 'Canvas',
      border: '1px solid GrayText',
      font: '14px/1.5 system-ui, sans-serif',
      textAlign: 'start',
      boxSizing: 'border-box',
    });

    const header = this.document.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' });
    const title = this.document.createElement('strong');
    title.textContent = '译文审查';
    Object.assign(title.style, { flex: '1' });

    const learningLabel = this.document.createElement('label');
    const learning = this.document.createElement('input');
    learning.type = 'checkbox';
    learning.setAttribute('data-translation-review-learning', '');
    learning.addEventListener('change', () => {
      this.learningEnabled = learning.checked;
      this.callbacks.learning(this.learningEnabled);
      this.refresh(true);
    });
    learningLabel.append(learning, this.document.createTextNode(' 学习模式'));

    const close = this.document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.setAttribute('aria-label', '关闭译文审查');
    close.addEventListener('click', () => this.close());
    header.append(title, learningLabel, close);

    const summary = this.document.createElement('div');
    summary.setAttribute('data-translation-review-summary', '');
    summary.setAttribute('aria-live', 'polite');
    Object.assign(summary.style, { marginBlock: '8px' });

    const list = this.document.createElement('ol');
    list.setAttribute('data-translation-review-list', '');
    Object.assign(list.style, { margin: '0', paddingInlineStart: '24px' });

    const pagination = this.document.createElement('div');
    Object.assign(pagination.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBlockStart: '8px' });
    const previous = this.document.createElement('button');
    previous.type = 'button';
    previous.textContent = '上一页';
    previous.addEventListener('click', () => {
      if (this.pageIndex > 0) {
        --this.pageIndex;
        this.render();
      }
    });
    const page = this.document.createElement('span');
    page.setAttribute('data-translation-review-page', '');
    const next = this.document.createElement('button');
    next.type = 'button';
    next.textContent = '下一页';
    next.addEventListener('click', () => {
      if ((this.pageIndex + 1) * pageSize < this.entries.length) {
        ++this.pageIndex;
        this.render();
      }
    });
    pagination.append(previous, page, next);

    root.append(header, summary, list, pagination);
    this.document.documentElement.append(root);
    return { root, learning, summary, list, previous, page, next };
  }

  private render(): void {
    const ui = this.ui;
    if (!ui) return;
    const totalPages = Math.ceil(this.entries.length / pageSize);
    ui.learning.checked = this.learningEnabled;
    ui.summary.textContent = this.entries.length ? `共 ${this.entries.length} 条译文` : '暂无可审查的译文。';
    ui.list.replaceChildren();

    if (!this.entries.length) {
      const empty = this.document.createElement('li');
      empty.setAttribute('data-translation-review-empty', '');
      empty.textContent = '页面尚无已完成译文。';
      ui.list.append(empty);
    } else {
      const start = this.pageIndex * pageSize;
      for (const entry of this.entries.slice(start, start + pageSize)) this.renderEntry(entry, ui.list);
    }

    ui.previous.disabled = this.pageIndex === 0;
    ui.next.disabled = this.pageIndex + 1 >= totalPages;
    ui.page.textContent = totalPages ? `${this.pageIndex + 1} / ${totalPages}` : '0 / 0';
  }

  private renderEntry(entry: TranslationReviewEntry, list: HTMLOListElement): void {
    const item = this.document.createElement('li');
    item.setAttribute('data-translation-review-entry', entry.id);
    Object.assign(item.style, { paddingBlock: '8px', borderBlockStart: '1px solid GrayText' });

    const sourceLabel = this.document.createElement('strong');
    sourceLabel.textContent = '原文';
    const source = this.document.createElement('div');
    source.setAttribute('data-translation-review-source', '');
    source.textContent = entry.source;
    Object.assign(source.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginBlockEnd: '6px' });

    const translationLabel = this.document.createElement('label');
    translationLabel.textContent = '当前译文';
    const textarea = this.document.createElement('textarea');
    textarea.value = this.drafts.get(entry.id) ?? entry.translation;
    textarea.addEventListener('input', () => this.drafts.set(entry.id, textarea.value));
    textarea.hidden = this.learningEnabled && !entry.revealed;
    translationLabel.hidden = textarea.hidden;
    textarea.rows = 4;
    textarea.setAttribute('data-translation-review-translation', '');
    textarea.setAttribute('aria-label', `编辑“${entry.source}”的译文`);
    Object.assign(textarea.style, { display: textarea.hidden ? 'none' : 'block', width: '100%', boxSizing: 'border-box', resize: 'vertical' });

    const actions = this.document.createElement('div');
    Object.assign(actions.style, { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginBlockStart: '6px' });
    const save = this.document.createElement('button');
    save.type = 'button';
    save.textContent = '保存';
    save.disabled = textarea.hidden;
    save.addEventListener('click', () => {
      this.drafts.delete(entry.id);
      this.callbacks.edit(entry.id, textarea.value);
      this.refresh(true);
    });
    const reset = this.document.createElement('button');
    reset.type = 'button';
    reset.textContent = '恢复服务译文';
    reset.disabled = !entry.edited || textarea.hidden;
    reset.addEventListener('click', () => {
      this.drafts.delete(entry.id);
      this.callbacks.reset(entry.id);
      this.refresh(true);
    });
    const reveal = this.document.createElement('button');
    reveal.type = 'button';
    reveal.hidden = !this.learningEnabled;
    reveal.textContent = entry.revealed ? '遮蔽译文' : '揭示译文';
    reveal.setAttribute('aria-pressed', String(entry.revealed));
    reveal.addEventListener('click', () => {
      this.callbacks.reveal(entry.id, !entry.revealed);
      this.refresh();
    });
    actions.append(save, reset, reveal);
    if (entry.edited) {
      const edited = this.document.createElement('span');
      edited.textContent = '已编辑';
      edited.setAttribute('data-translation-review-edited', '');
      actions.append(edited);
    }

    item.append(sourceLabel, source, translationLabel, textarea, actions);
    list.append(item);
  }
}
