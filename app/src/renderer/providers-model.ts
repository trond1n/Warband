import type { Capabilities, LocalCheck, LoginState, Mismatch, ProbeResult, ProviderProblem, ProviderSettings, RunnerId, VersionDrift } from '../shared/api.ts';

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

/**
 * What the card says about the adapter: the version it was verified on (in
 * the code), and apart from it the version the probes last passed on here.
 */
export function adapterLabel(capabilities: Capabilities, check?: LocalCheck): string {
  if (!capabilities.verified) return 'не подтверждён: поведение без человека не проверено';
  const base = capabilities.verifiedOn ? `подтверждён на ${capabilities.verifiedOn}` : 'подтверждён пробами';
  const local = check && check.differs.length === 0 ? `, на этой машине пробы прошли на ${shortVersion(check.version)}` : '';
  return `${base}${local}`;
}

/** "2.1.330 (Claude Code)" -> "2.1.330". */
const shortVersion = (text: string): string => /\d+(?:\.\d+)+/.exec(text)?.[0] ?? text;

/** A warning when the installed CLI is not the version its adapter was verified on; undefined when there is none. */
export function driftText(drift: VersionDrift): string | undefined {
  if (drift.kind === 'differs' && drift.failed) {
    return `Установлена версия ${drift.installed}, а адаптер подтверждён на ${drift.verifiedOn}. Пробы на этой версии дали другой результат: ${drift.failed.join(', ')}. Поведение без человека изменилось, сверьтесь с docs/runners.md. Прогоны это не блокирует.`;
  }
  if (drift.kind === 'differs') {
    return `Установлена версия ${drift.installed}, а адаптер подтверждён на ${drift.verifiedOn}${drift.newer ? '' : ' (установленная старше)'}. Поведение без человека могло измениться: запустите пробы. Прогоны это не блокирует.`;
  }
  if (drift.kind === 'unknown') {
    return `CLI не сообщил версию, которую можно сравнить с ${drift.verifiedOn}, на которой подтверждён адаптер. Запустите пробы. Прогоны это не блокирует.`;
  }
  return undefined;
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

const FIELD_LABEL: Record<Mismatch['field'], string> = { answer: 'ответ', file: 'файл', exit: 'выход', missing: 'проба' };
const VALUE_LABEL: Record<string, string> = { yes: 'да', no: 'нет', '': 'нет данных', run: 'запущена', 'not run': 'не запущена' };
const valueLabel = (value: string): string => VALUE_LABEL[value] ?? value;

/** How one probe compares with the results the adapter was verified with; undefined when nothing was compared. */
export function matchText(mismatches: readonly Mismatch[] | undefined, probe: string): string | undefined {
  if (!mismatches) return undefined;
  const own = mismatches.filter((m) => m.probe === probe);
  if (own.length === 0) return 'совпадает';
  return own.map((m) => `${FIELD_LABEL[m.field]}: ${valueLabel(m.actual)}, записано ${valueLabel(m.expected)}`).join('; ');
}

/** The line under the probe table after a full run on a verified CLI. */
export function checkText(check: LocalCheck | undefined): string | undefined {
  if (!check) return undefined;
  if (check.differs.length === 0) {
    return `Все пробы совпали с результатами, на которых подтверждён адаптер. Версия ${shortVersion(check.version)} запомнена как проверенная на этой машине: предупреждения о ней не будет.`;
  }
  return `Отличаются: ${check.differs.join(', ')}. Версия ${shortVersion(check.version)} не считается проверенной, предупреждение остаётся.`;
}
