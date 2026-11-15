import { contextBridge, ipcRenderer } from 'electron';

import type { TimedEvent, WarbandApi } from '../shared/api.ts';

const call =
  (channel: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(`warband:${channel}`, ...args) as Promise<never>;

const api: WarbandApi = {
  state: call('state'),
  addProject: call('addProject'),
  selectProject: call('selectProject'),
  removeProject: call('removeProject'),
  project: call('project'),
  runs: call('runs'),
  run: call('run'),
  start: call('start'),
  cancel: call('cancel'),
  decide: call('decide'),
  answer: call('answer'),
  diff: call('diff'),
  plans: call('plans'),
  openReslop: call('openReslop'),
  merge: call('merge'),
  openPath: call('openPath'),
  onEvent(listener) {
    const wrapped = (_: unknown, runId: string, event: TimedEvent): void => listener(runId, event);
    ipcRenderer.on('warband:event', wrapped);
    return () => ipcRenderer.removeListener('warband:event', wrapped);
  },
};

contextBridge.exposeInMainWorld('warband', api);
