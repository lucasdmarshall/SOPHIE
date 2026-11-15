import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Markup for the app drawer and the terminal; main.ts places it inside #holo. */
export const SHELL_MARKUP = `
  <section class="apps-panel panel" id="apps-panel" hidden aria-label="App drawer">
    <header class="shell-head">
      <span class="panel-title">APPS // LAUNCHER</span>
      <span class="shell-count" id="apps-count"></span>
      <button class="holo-button small" id="apps-refresh">↻ RESCAN</button>
      <button class="holo-button small" id="apps-close">✕</button>
    </header>
    <input class="shell-input" id="apps-search" type="search" placeholder="SEARCH APPS" spellcheck="false" autocomplete="off">
    <div class="apps-grid" id="apps-grid"></div>
  </section>

  <section class="term-panel panel" id="term-panel" hidden aria-label="Terminal">
    <header class="shell-head" id="term-head">
      <span class="panel-title">SHELL // TERMINAL</span>
      <span class="shell-count" id="term-state">OFFLINE</span>
      <button class="holo-button small danger" id="term-stop">■ STOP</button>
      <button class="holo-button small" id="term-clear">CLEAR</button>
      <button class="holo-button small" id="term-close">✕</button>
    </header>
    <div class="term-output" id="term-output" tabindex="-1"></div>
    <label class="term-line"><span class="term-prompt" id="term-prompt">PS ›</span>
      <input class="shell-input" id="term-input" spellcheck="false" autocomplete="off" autocapitalize="off">
    </label>
  </section>
`;

interface HoloApp {
  name: string;
  id: string;
}

interface TermEvent {
  kind: 'out' | 'err' | 'done' | 'exit';
  text: string;
}

type Notify = (text: string, kind?: 'info' | 'error') => void;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
/** Oldest output is dropped past this many lines, so a chatty command cannot bloat the page. */
const MAX_LINES = 1500;

/** Up to two letters that stand in for an app's icon. */
function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

/** The Start menu, as a grid of launch tiles with a search box. */
export class AppDrawer {
  private readonly panel = $('#apps-panel');
  private readonly grid = $('#apps-grid');
  private readonly search = $<HTMLInputElement>('#apps-search');
  private apps: HoloApp[] | null = null;
  private loading = false;

  constructor(private readonly notify: Notify) {
    $('#apps-close').addEventListener('click', () => this.close());
    $('#apps-refresh').addEventListener('click', () => void this.load());
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (event) => {
      // Enter launches the first match, so the keyboard alone is enough.
      if (event.key === 'Enter') this.grid.querySelector<HTMLButtonElement>('.app-tile')?.click();
    });
    this.grid.addEventListener('click', (event) => {
      const id = (event.target as HTMLElement).closest<HTMLButtonElement>('.app-tile')?.dataset.id;
      const app = this.apps?.find((candidate) => candidate.id === id);
      if (app) void this.launch(app);
    });
  }

  get open(): boolean {
    return !this.panel.hidden;
  }

  toggle(): void {
    if (this.open) {
      this.close();
      return;
    }
    this.panel.hidden = false;
    this.search.value = '';
    if (this.apps) this.render();
    else void this.load();
    this.search.focus();
  }

  close(): void {
    this.panel.hidden = true;
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.grid.innerHTML = '<p class="shell-note">SCANNING INSTALLED APPS…</p>';
    try {
      this.apps = await invoke<HoloApp[]>('holo_apps');
      this.render();
    } catch (error) {
      this.grid.innerHTML = '';
      const note = document.createElement('p');
      note.className = 'shell-note';
      note.textContent = `APP SCAN FAILED // ${String(error).toUpperCase()}`;
      this.grid.append(note);
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    const apps = this.apps ?? [];
    const query = this.search.value.trim().toLowerCase();
    const matches = query ? apps.filter((app) => app.name.toLowerCase().includes(query)) : apps;
    $('#apps-count').textContent = `${matches.length} / ${apps.length}`;
    this.grid.replaceChildren(
      ...matches.map((app, index) => {
        const tile = document.createElement('button');
        tile.className = 'app-tile';
        tile.dataset.id = app.id;
        tile.dataset.tone = String(index % 3);
        const glyph = document.createElement('span');
        glyph.className = 'app-glyph';
        glyph.textContent = initials(app.name);
        const name = document.createElement('span');
        name.className = 'app-name';
        name.textContent = app.name;
        tile.append(glyph, name);
        return tile;
      }),
    );
    if (!matches.length) this.grid.innerHTML = '<p class="shell-note">NO MATCH</p>';
  }

  private async launch(app: HoloApp): Promise<void> {
    try {
      await invoke('holo_launch', { id: app.id });
      this.notify(`LAUNCHING // ${app.name.toUpperCase()}`);
      this.close();
    } catch (error) {
      this.notify(`LAUNCH FAILED // ${String(error).toUpperCase()}`, 'error');
    }
  }
}

/** A PowerShell session in a holo panel. Commands run one at a time; state carries over. */
export class Terminal {
  private readonly panel = $('#term-panel');
  private readonly output = $('#term-output');
  private readonly input = $<HTMLInputElement>('#term-input');
  private readonly history: string[] = [];
  private historyAt = 0;
  private cwd = '';
  private running = false;
  private started = false;
  private lines = 0;

  constructor(private readonly notify: Notify) {
    $('#term-close').addEventListener('click', () => this.close());
    $('#term-clear').addEventListener('click', () => this.clear());
    $('#term-stop').addEventListener('click', () => void this.stop());
    this.output.addEventListener('click', () => {
      // Clicking the output focuses the prompt, unless the user is selecting text to copy.
      if (!window.getSelection()?.toString()) this.input.focus();
    });
    this.input.addEventListener('keydown', (event) => this.key(event));
    this.bindDrag();
    void listen<TermEvent>('holo-term', ({ payload }) => this.receive(payload));
    this.setState();
  }

  get open(): boolean {
    return !this.panel.hidden;
  }

  toggle(): void {
    if (this.open) {
      this.close();
      return;
    }
    this.panel.hidden = false;
    this.input.focus();
    if (!this.started) {
      this.started = true;
      this.print('SOPHIE SHELL // POWERSHELL SESSION', 'info');
      this.print('One command at a time. Full-screen programs (editors, REPLs) are not supported.', 'info');
      this.running = true;
      this.setState();
      invoke('term_start').catch((error) => this.fail(error));
    }
  }

  close(): void {
    this.panel.hidden = true;
  }

  private key(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      const command = this.input.value;
      this.input.value = '';
      if (command.trim()) this.run(command);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.historyAt = Math.max(0, Math.min(this.history.length, this.historyAt + (event.key === 'ArrowUp' ? -1 : 1)));
      this.input.value = this.history[this.historyAt] ?? '';
    } else if (event.key.toLowerCase() === 'c' && event.ctrlKey && !this.input.value && this.running) {
      void this.stop();
    } else if (event.key.toLowerCase() === 'l' && event.ctrlKey) {
      event.preventDefault();
      this.clear();
    }
  }

  private run(command: string): void {
    if (this.running) {
      this.notify('SHELL BUSY // STOP THE RUNNING COMMAND FIRST', 'error');
      this.input.value = command;
      return;
    }
    if (this.history[this.history.length - 1] !== command) this.history.push(command);
    this.historyAt = this.history.length;
    this.print(`${this.promptText()} ${command}`, 'cmd');
    const local = command.trim().toLowerCase();
    if (local === 'cls' || local === 'clear') {
      this.clear();
      return;
    }
    if (local === 'exit') {
      this.close();
      return;
    }
    this.running = true;
    this.setState();
    invoke('term_run', { command }).catch((error) => this.fail(error));
  }

  private async stop(): Promise<void> {
    await invoke('term_stop').catch(() => {});
  }

  private fail(error: unknown): void {
    this.print(String(error), 'err');
    this.running = false;
    this.setState();
  }

  private receive(event: TermEvent): void {
    if (event.kind === 'done') {
      this.cwd = event.text;
      this.running = false;
      this.setState();
    } else if (event.kind === 'exit') {
      if (this.running) this.print('— session ended; the next command starts a new one —', 'info');
      this.running = false;
      this.setState();
    } else {
      this.print(event.text, event.kind);
    }
  }

  private promptText(): string {
    return `PS ${this.cwd} ›`;
  }

  private setState(): void {
    $('#term-prompt').textContent = this.promptText();
    $('#term-state').textContent = this.running ? 'RUNNING' : this.started ? 'READY' : 'OFFLINE';
    this.panel.classList.toggle('is-running', this.running);
    $<HTMLButtonElement>('#term-stop').disabled = !this.running;
  }

  private print(text: string, kind: 'out' | 'err' | 'cmd' | 'info'): void {
    const stick = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 40;
    const line = document.createElement('div');
    line.className = `term-${kind}`;
    line.textContent = text || ' ';
    this.output.append(line);
    this.lines += 1;
    while (this.lines > MAX_LINES && this.output.firstChild) {
      this.output.firstChild.remove();
      this.lines -= 1;
    }
    if (stick) this.output.scrollTop = this.output.scrollHeight;
  }

  private clear(): void {
    this.output.replaceChildren();
    this.lines = 0;
  }

  /** Drag the panel by its title bar. */
  private bindDrag(): void {
    const head = $('#term-head');
    head.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      const rect = this.panel.getBoundingClientRect();
      const dx = event.clientX - rect.left;
      const dy = event.clientY - rect.top;
      head.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent) => {
        const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - dx));
        const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy));
        this.panel.style.left = `${x}px`;
        this.panel.style.top = `${y}px`;
        this.panel.style.bottom = 'auto';
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }
}
