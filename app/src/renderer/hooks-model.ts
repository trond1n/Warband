import type { Hook, HookInput, HookProblem } from '../shared/api.ts';

/*
 * Labels and form logic for the "Хуки" screen, kept apart from React so
 * they can be tested with node:test.
 */

export type StageId = Hook['stage'];

/** The stages in the order the wizard offers them, with the same explanations. */
export const STAGES: readonly { id: StageId; label: string; about: string }[] = [
  { id: 'checks', label: 'checks', about: 'после того как код написан; ошибка возвращает работу на доработку' },
  { id: 'finish', label: 'finish', about: 'прямо перед коммитом (как pre-commit)' },
  { id: 'setup', label: 'setup', about: 'один раз в новом worktree, до любого агента (например, установка зависимостей)' },
];

export interface HookForm {
  name: string;
  description: string;
  run: string;
  stage: StageId;
  /** Environment variables as rows: name and value. */
  env: [string, string][];
  reduce: boolean;
}

export const blankForm = (): HookForm => ({ name: '', description: '', run: '', stage: 'checks', env: [], reduce: false });

export const formOf = (hook: Hook): HookForm => ({
  name: hook.name,
  description: hook.description,
  run: hook.run,
  stage: hook.stage,
  env: Object.entries(hook.env ?? {}),
  reduce: hook.reduce === true,
});

/**
 * What the form sends to the core. `reduce` only goes with the checks stage,
 * as in the wizard, which asks about reslop for checks hooks only.
 */
export const inputOf = (form: HookForm): HookInput => ({
  name: form.name,
  description: form.description,
  run: form.run,
  stage: form.stage,
  env: form.env.map(([k, v]) => [k, v] as const),
  reduce: form.stage === 'checks' && form.reduce,
});

/** The form as the core would store it, for comparing; the core still validates the real thing. */
function normalized(form: HookForm): string {
  const input = inputOf(form);
  return JSON.stringify({
    name: input.name.trim().replace(/^\/+/, '').toLowerCase(),
    description: input.description.trim(),
    run: input.run.trim(),
    stage: input.stage,
    env: input.env.map(([k, v]) => [k.trim(), v]).filter(([k, v]) => k !== '' || (v ?? '').trim() !== ''),
    reduce: input.reduce,
  });
}

/** The form differs from the saved hook (or, for a new hook, from an empty form). */
export function isDirty(form: HookForm, saved: Hook | undefined): boolean {
  return normalized(form) !== normalized(saved ? formOf(saved) : blankForm());
}

/** A free name for a copy: unit-copy, then unit-copy-2 and so on. */
export function copyName(name: string, taken: readonly string[]): string {
  const base = `${name}-copy`;
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Policy rules that deny a command, in the window's language. */
export const RULE_LABEL: Record<string, string> = {
  'shell.rm-recursive-force': 'рекурсивное удаление без подтверждения (rm -rf)',
  'shell.git-force-push': 'принудительный push переписывает историю на сервере',
  'shell.reads-secret-file': 'команда обращается к файлу с секретами (.env, ключи)',
  'fs.secret-file': 'файл с секретами',
  'fs.write-outside-workspace': 'запись вне рабочей папки',
};

const agentList = (agents: readonly string[] | undefined): string => (agents ?? []).map((a) => `/${a}`).join(', ');

/** The same problems the core reports, in the window's language. `original`: the hook's name when the form opened. */
export function problemText(problem: HookProblem, original?: string): string {
  switch (problem.code) {
    case 'name-invalid':
      return 'Только строчные латинские буквы, цифры и дефисы, например test или lint-fix.';
    case 'name-taken':
      return 'Хук с таким именем уже есть.';
    case 'rename-in-use':
      return `Хук используют агенты ${agentList(problem.agents)}: с новым именем они остались бы без него. Сохраните его под прежним именем${original ? ` «${original}»` : ''} или сделайте копию кнопкой «Дублировать».`;
    case 'run-empty':
      return 'Укажите команду.';
    case 'run-denied':
      return `Политика запрещает эту команду: ${problem.rule ? (RULE_LABEL[problem.rule] ?? problem.rule) : 'правило deny'}. Такой хук не сохраняется.`;
    case 'stage-unknown':
      return 'Выберите, когда запускать хук.';
    case 'env-name-invalid':
      return problem.key ? `«${problem.key}»: имя переменной из латинских букв, цифр и _, не начинается с цифры.` : 'У переменной со значением нет имени.';
    case 'env-name-duplicate':
      return `«${problem.key ?? ''}» указана дважды.`;
  }
}

export const STAGE_SHORT: Record<StageId, string> = { setup: 'setup', checks: 'checks', finish: 'finish' };

/** Who uses the hook, for the list and the form. */
export function usedByText(usedBy: readonly string[] | undefined): string {
  if (usedBy === undefined) return 'не удалось прочитать агентов';
  if (usedBy.length === 0) return 'не используется агентами';
  return `используют ${agentList(usedBy)}`;
}

/** "1,2 с" or "2 мин 05 с". */
export function secondsText(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} с`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m} мин ${String(s).padStart(2, '0')} с`;
}
