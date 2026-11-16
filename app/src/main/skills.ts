import { relative } from 'node:path';

import { promptSize, splitSkill } from '../../../src/core/skills.ts';
import { deleteSkill, listAgents, readSkills, saveSkill, SkillChangedError, SkillInUseError, SkillInvalidError } from '../../../src/core/workspace.ts';
import type { SkillInput } from '../../../src/core/workspace.ts';
import type { DeleteSkillResult, SaveSkillResult, SkillInfo, SkillsView } from '../shared/api.ts';

/*
 * The "Скиллы" screen: the Markdown files in .warband/skills/, edited one
 * at a time through the core. No Electron here, so it is tested with
 * node:test.
 */

export class SkillService {
  async view(root: string): Promise<SkillsView> {
    let files;
    try {
      files = await readSkills(root);
    } catch (err) {
      return { skills: [], error: (err as Error).message };
    }
    // A broken agent file must not hide the skills; "used by" is then unknown.
    let agents: { name: string; skills: string[] }[] | undefined;
    let agentsError: string | undefined;
    try {
      agents = await listAgents(root);
    } catch (err) {
      agentsError = (err as Error).message;
    }
    const skills = files.map((f): SkillInfo => {
      const parts = splitSkill(f.text);
      return {
        name: f.name,
        description: f.description,
        body: parts.body,
        extra: parts.extra,
        file: relative(root, f.path).replaceAll('\\', '/'),
        version: f.version,
        size: promptSize(f.text),
        ...(agents ? { usedBy: agents.filter((a) => a.skills.includes(f.name)).map((a) => a.name) } : {}),
      };
    });
    return { skills, ...(agentsError ? { agentsError } : {}) };
  }

  async save(root: string, input: SkillInput, original: string | undefined, version: string, renameAgents?: readonly string[]): Promise<SaveSkillResult> {
    try {
      const saved = await saveSkill(root, input, {
        ...(original !== undefined ? { original, expectedVersion: version } : {}),
        ...(renameAgents ? { renameAgents } : {}),
      });
      return { ok: true, version: saved.version, name: saved.name };
    } catch (err) {
      if (err instanceof SkillInvalidError) return { ok: false, problems: err.problems };
      if (err instanceof SkillChangedError) return { ok: false, changed: true };
      return { ok: false, error: (err as Error).message };
    }
  }

  async remove(root: string, name: string, version: string): Promise<DeleteSkillResult> {
    try {
      await deleteSkill(root, name, version);
      return { ok: true };
    } catch (err) {
      if (err instanceof SkillInUseError) return { ok: false, usedBy: err.agents };
      if (err instanceof SkillChangedError) return { ok: false, changed: true };
      return { ok: false, error: (err as Error).message };
    }
  }
}
