/** Names of agents, skills and hooks: used as commands, file names and references. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Run ids as the engine makes them: <agent>-<yyyymmdd>-<hhmmss>, with -2, -3... for runs in the same second. */
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*-\d{8}-\d{6}(-\d+)?$/;
