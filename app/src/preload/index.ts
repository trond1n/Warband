import { contextBridge, ipcRenderer } from 'electron';

import type { ProbeState, RunnerId, TimedEvent, WarbandApi } from '../shared/api.ts';

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
  providers: call('providers'),
  saveProvider: call('saveProvider'),
  probe: call('probe'),
  cancelProbe: call('cancelProbe'),
  runnerDocs: call('runnerDocs'),
  hooks: call('hooks'),
  saveHook: call('saveHook'),
  deleteHook: call('deleteHook'),
  trialRequest: call('trialRequest'),
  trialHook: call('trialHook'),
  cancelTrial: call('cancelTrial'),
  skills: call('skills'),
  saveSkill: call('saveSkill'),
  deleteSkill: call('deleteSkill'),
  onWorkspaceChanged(listener) {
    const wrapped = (_: unknown, root: string): void => listener(root);
    ipcRenderer.on('warband:workspace-changed', wrapped);
    return () => ipcRenderer.removeListener('warband:workspace-changed', wrapped);
  },
  onProbe(listener) {
    const wrapped = (_: unknown, id: RunnerId, state: ProbeState): void => listener(id, state);
    ipcRenderer.on('warband:probe', wrapped);
    return () => ipcRenderer.removeListener('warband:probe', wrapped);
  },
  onProvidersChanged(listener) {
    const wrapped = (): void => listener();
    ipcRenderer.on('warband:providers-changed', wrapped);
    return () => ipcRenderer.removeListener('warband:providers-changed', wrapped);
  },
  onEvent(listener) {
    const wrapped = (_: unknown, runId: string, event: TimedEvent): void => listener(runId, event);
    ipcRenderer.on('warband:event', wrapped);
    return () => ipcRenderer.removeListener('warband:event', wrapped);
  },
};

contextBridge.exposeInMainWorld('warband', api);
