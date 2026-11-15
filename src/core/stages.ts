export const STAGES = [
  'clarify',
  'plan',
  'approve',
  'implement',
  'checks',
  'review',
  'accept',
  'finish',
] as const;

export type Stage = (typeof STAGES)[number];

/** Stages where the run stops and waits for a person. */
export const HUMAN_GATES: ReadonlySet<Stage> = new Set<Stage>(['approve', 'accept']);

export type Outcome = 'ok' | 'failed' | 'changes_requested' | 'rejected';

export type RunStatus = 'running' | 'waiting_human' | 'done' | 'halted';

export interface RunState {
  stage: Stage;
  status: RunStatus;
  /** How many times the task has been sent back to `implement`. */
  reworks: number;
  haltReason?: string;
}

export interface RouteOptions {
  maxReworks: number;
}

export const DEFAULT_ROUTE: RouteOptions = { maxReworks: 3 };

export function initialState(): RunState {
  return { stage: 'clarify', status: 'running', reworks: 0 };
}

const at = (stage: Stage, reworks: number): RunState => ({
  stage,
  status: HUMAN_GATES.has(stage) ? 'waiting_human' : 'running',
  reworks,
});

const halt = (state: RunState, haltReason: string): RunState => ({
  ...state,
  status: 'halted',
  haltReason,
});

/**
 * Pure routing: given where a run is and how the current stage ended,
 * returns where it goes next. No agent can skip a stage, because the only
 * way forward is through this function.
 */
export function advance(
  state: RunState,
  outcome: Outcome,
  options: RouteOptions = DEFAULT_ROUTE,
): RunState {
  if (state.status === 'done' || state.status === 'halted') {
    throw new Error(`run is ${state.status}, it cannot advance`);
  }

  const rework = (): RunState =>
    state.reworks >= options.maxReworks
      ? halt(state, `rework limit of ${options.maxReworks} reached at ${state.stage}`)
      : at('implement', state.reworks + 1);

  const invalid = (): never => {
    throw new Error(`outcome "${outcome}" is not valid at stage "${state.stage}"`);
  };

  switch (state.stage) {
    case 'clarify':
      if (outcome === 'ok') return at('plan', state.reworks);
      if (outcome === 'failed') return halt(state, 'clarify failed');
      return invalid();

    case 'plan':
      if (outcome === 'ok') return at('approve', state.reworks);
      if (outcome === 'failed') return halt(state, 'plan failed');
      return invalid();

    case 'approve':
      if (outcome === 'ok') return at('implement', state.reworks);
      if (outcome === 'changes_requested') return at('plan', state.reworks);
      if (outcome === 'rejected') return halt(state, 'plan rejected by human');
      return invalid();

    case 'implement':
      if (outcome === 'ok') return at('checks', state.reworks);
      if (outcome === 'failed') return rework();
      return invalid();

    case 'checks':
      if (outcome === 'ok') return at('review', state.reworks);
      if (outcome === 'failed') return rework();
      return invalid();

    case 'review':
      if (outcome === 'ok') return at('accept', state.reworks);
      if (outcome === 'changes_requested') return rework();
      if (outcome === 'failed') return halt(state, 'review failed');
      return invalid();

    case 'accept':
      if (outcome === 'ok') return at('finish', state.reworks);
      if (outcome === 'changes_requested') return rework();
      if (outcome === 'rejected') return halt(state, 'result rejected by human');
      return invalid();

    case 'finish':
      if (outcome === 'ok') return { stage: 'finish', status: 'done', reworks: state.reworks };
      if (outcome === 'failed') return halt(state, 'finish failed');
      return invalid();
  }
}
