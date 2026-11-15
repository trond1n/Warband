import type { Capabilities, LoginState, ProbeResult, ProviderProblem, ProviderSettings, RunnerId } from '../shared/api.ts';

/*
 * Labels and form logic for the "Провайдеры" screen, kept apart from React
 * so they can be tested with node:test.
 */

export const SANDBOX_LABEL: Record<Capabilities['sandbox'], string> = {
  os: 'песочница ОС',
  agent: 'правила разрешений самого CLI, без песочницы ОС',
  none: 'нет',
};

export const APPROVALS_LABEL: Record<Capabilities['headlessApprovals'], string> = {
  'auto-run': 'выполняет всё без спроса',
  deny: 'отклоняет сразу, прогон продолжается',
  'may-hang': 'может зависнуть в ожидании ответа',
  unknown: 'неизвестно',
};

export function loginLabel(login: LoginState, found: boolean): string {
  if (!found) return 'неизвестно: CLI не найден';
  if (login.state === 'in') return `выполнен${login.method ? ` (${login.method})` : ''}`;
  if (login.state === 'out') return 'не выполнен';
  return 'неизвестно: CLI сам этого не сообщает';
}

/** Section of docs/runners.md for each CLI. */
export const DOCS_SECTION: Record<RunnerId, string> = {
  claude: 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
  kimi: 'kimi',
};

/** The same problems the core reports, in the window's language. */
export function problemText(problem: ProviderProblem): string {
  switch (problem.code) {
    case 'binary-relative':
      return 'Укажите полный путь к программе или оставьте поле пустым, чтобы искать её в PATH.';
    case 'binary-missing':
      return 'По этому пути нет файла.';
    case 'binary-not-file':
      return 'Это папка, а не программа.';
    case 'binary-script':
      return 'Скрипт (.cmd, .bat, .ps1) нельзя запустить без оболочки. Укажите путь к .exe.';
    case 'model-invalid':
      return `«${problem.model ?? ''}»: допустимы буквы, цифры и . _ : / @ [ ] -, в начале не может быть дефиса.`;
    case 'model-duplicate':
      return `«${problem.model ?? ''}» указан дважды.`;
  }
}

export interface ProviderForm {
  binary: string;
  /** One model id per line. */
  models: string;
}

export const formOf = (settings: ProviderSettings): ProviderForm => ({ binary: settings.binary ?? '', models: settings.models.join('\n') });

/** What the form would save; the core trims and validates it again. */
export const settingsOf = (form: ProviderForm): ProviderSettings => {
  const binary = form.binary.trim();
  return { ...(binary ? { binary } : {}), models: form.models.split(/\r?\n/).map((m) => m.trim()).filter(Boolean) };
};

/** The form differs from what is saved, ignoring blanks the save would drop. */
export function isDirty(form: ProviderForm, saved: ProviderSettings): boolean {
  const now = settingsOf(form);
  return (now.binary ?? '') !== (saved.binary ?? '') || now.models.join('\n') !== saved.models.join('\n');
}

/** What each probe checks and what a healthy result looks like. */
export const PROBE_LABEL: Record<string, string> = {
  pong: 'простой ответ без инструментов',
  write: 'в режиме чтения просим создать файл: должно быть отклонено',
  read: 'чтение файла без подтверждения',
  edit: 'в режиме правки: файл создаётся, команда отклоняется',
  verdict: 'ответ по JSON-схеме',
  'outside-read': 'чтение файла выше рабочей папки командой: маркера быть не должно',
  'repo-settings': 'настройки репозитория расширяют доступ: маркера быть не должно',
  'outside-grep': 'поиск в файле выше рабочей папки: маркера быть не должно',
  'outside-write': 'запись выше рабочей папки: файла быть не должно',
};

const YES_NO: Record<string, string> = { yes: 'да', no: 'нет' };

/** A probe result as table cells, in the window's language where the value is a plain yes or no. */
export function probeRow(result: ProbeResult): { probe: string; about: string; answer: string; file: string; tools: string; exit: string; seconds: string; cleanup: string } {
  return {
    probe: result.probe,
    about: PROBE_LABEL[result.probe] ?? '',
    answer: YES_NO[result['saw answer']] ?? result['saw answer'],
    file: result['file created'] === '' ? '—' : result['file created'].replace(/^yes/, 'да').replace(/^no$/, 'нет'),
    tools: result.tools || '—',
    exit: result.exit,
    seconds: result.seconds,
    cleanup: result.cleanup === 'ok' ? 'ok' : result.cleanup,
  };
}
