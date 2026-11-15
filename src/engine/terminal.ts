import type { Prompter } from '../wizard/agent-wizard.ts';
import { findingLine, pendingPlans, readPlans } from './plan-file.ts';
import type { EngineEvent, GateDecision, HumanGate } from './run.ts';

/*
 * The terminal face of a run: renders engine events as they happen and asks
 * the person at the gates. Everything here works off EngineEvent, so another
 * UI can replace it without touching the engine.
 */

const ROLE_LABEL = { planner: 'planner', implementer: 'implementer', reviewer: 'reviewer' } as const;
const indent = (text: string, by = '  '): string => text.split('\n').map((line) => `${by}${line}`).join('\n');

export function renderEvent(event: EngineEvent, say: (text: string) => void): void {
  switch (event.type) {
    case 'run_started':
      say(`Run ${event.runId}`);
      say(`  worktree: ${event.worktree}`);
      say(`  branch:   ${event.branch}`);
      break;
    case 'warning':
      say(`! ${event.message}`);
      break;
    case 'stage':
      say(`\n== ${event.stage}${event.reworks > 0 ? ` (rework ${event.reworks})` : ''}`);
      break;
    case 'agent_started':
      say(`  ${ROLE_LABEL[event.role]}: ${event.runner}${event.model ? ` / ${event.model}` : ''}, ${event.access === 'edit' ? 'may edit files' : 'read only'}`);
      break;
    case 'agent': {
      const e = event.event;
      if (e.kind === 'tool_call' && e.name !== 'StructuredOutput') say(`    > ${e.name}${toolTarget(e.input)}`);
      else if (e.kind === 'assistant_text' && event.stage === 'implement') say(indent(e.text, '    '));
      else if (e.kind === 'result' && e.deniedTools.length > 0) say(`    denied: ${e.deniedTools.join(', ')}`);
      else if (e.kind === 'error') say(`    error: ${e.message}`);
      break;
    }
    case 'agent_finished':
      say(`  ${event.ok ? 'done' : 'FAILED'} in ${event.seconds}s`);
      break;
    case 'hook_started':
      say(`  ${event.stage === 'setup' ? 'setup' : 'hook'} ${event.name}: ${event.run} ...`);
      break;
    case 'hook':
      say(`  ${event.result.name}: ${event.result.ok ? 'passed' : `FAILED (${event.result.timedOut ? 'timed out' : `exit ${event.result.exitCode}`})`}`);
      if (!event.result.ok) say(indent(event.result.output.slice(-15).join('\n'), '    '));
      break;
    case 'gate':
    case 'gate_open':
      break;
    case 'review':
      say(`  verdict: ${event.verdict === 'approve' ? 'approved' : 'changes requested'}`);
      for (const f of event.findings) say(`    - ${findingLine(f)}`);
      break;
    case 'plan_written':
      say(`  plan .plan/${event.name}: ${event.findings} item(s) from the ${event.source}`);
      break;
    case 'run_finished':
      say('');
      if (event.state.status === 'done') {
        say(`Done. Committed ${event.commit?.slice(0, 10) ?? ''} on branch ${event.branch}.`);
        say(`Look at it:  git show ${event.branch}`);
        say(`Take it:     git merge ${event.branch}`);
      } else {
        say(`Stopped: ${event.state.haltReason ?? event.state.status}.`);
        if (event.worktree) say(`The unfinished work is kept in ${event.worktree}`);
      }
      if (event.archive) say(`Review plans and check logs: ${event.archive}`);
      break;
  }
}

function toolTarget(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const fields = input as Record<string, unknown>;
  const target = fields['file_path'] ?? fields['path'] ?? fields['pattern'] ?? fields['command'];
  return typeof target === 'string' ? ` ${target.length > 100 ? `${target.slice(0, 100)}...` : target}` : '';
}

async function askLines(io: Prompter, intro: string): Promise<string> {
  io.say(intro);
  const lines: string[] = [];
  while (true) {
    const line = await io.ask('> ');
    if (line.trim() === '') return lines.join('\n');
    lines.push(line);
  }
}

async function decide(io: Prompter, what: string, reslop?: () => Promise<GateDecision | undefined>): Promise<GateDecision> {
  while (true) {
    const answer = (await io.ask(`${what}: [y] yes, [c] request changes, ${reslop ? '[r] review in reslop, ' : ''}[n] reject: `))
      .trim()
      .toLowerCase();
    if (answer === 'r' && reslop) {
      const decision = await reslop();
      if (decision) return decision;
      continue;
    }
    if (answer === 'y' || answer === 'yes') return { outcome: 'ok' };
    if (answer === 'n' || answer === 'no') return { outcome: 'rejected' };
    if (answer === 'c') {
      const comment = await askLines(io, 'What should change? Finish with an empty line.');
      return comment.trim() === '' ? { outcome: 'changes_requested' } : { outcome: 'changes_requested', comment };
    }
    io.say(`  Answer y, c${reslop ? ', r' : ''} or n.`);
  }
}

/**
 * `openReslop` runs reslop in the worktree with the terminal handed over to
 * it, and resolves when the person quits it. Without it there is no [r].
 */
export function terminalGate(io: Prompter, openReslop?: (worktree: string) => Promise<void>): HumanGate {
  return {
    async answerQuestions(questions) {
      io.say('\nThe planner has questions:');
      questions.forEach((q, i) => io.say(`  ${i + 1}. ${q}`));
      return askLines(io, 'Answer them (finish with an empty line; an empty answer lets the planner decide).');
    },

    async reviewPlan(plan) {
      io.say('\n---------------- plan ----------------');
      io.say(plan);
      io.say('--------------------------------------');
      return decide(io, 'Approve this plan');
    },

    async acceptResult(result) {
      io.say('\n---------------- result ----------------');
      if (result.summary) io.say(result.summary);
      io.say('\nChanged files:');
      io.say(indent(result.diffStat.join('\n')));
      if (result.reviewComments.length > 0) {
        io.say('\nReviewer:');
        for (const comment of result.reviewComments) io.say(`  - ${comment}`);
      }
      io.say(`\nTo look closer, in another terminal: cd "${result.worktree}" && git diff --cached`);
      io.say('----------------------------------------');
      const reslop = openReslop
        ? async (): Promise<GateDecision | undefined> => {
            io.say('Opening reslop on the change. Write findings into a review plan there, then quit reslop.');
            await openReslop(result.worktree);
            const pending = pendingPlans(await readPlans(result.worktree));
            if (pending.length === 0) {
              io.say('No open review plan in .plan/.');
              return undefined;
            }
            io.say(`Open plans: ${pending.map((p) => `.plan/${p.name} (${p.open} item(s))`).join(', ')}`);
            const send = (await io.ask('Send them back for rework? [y/n]: ')).trim().toLowerCase();
            return send === 'y' || send === 'yes' ? { outcome: 'changes_requested' } : undefined;
          }
        : undefined;
      return decide(io, 'Accept and commit', reslop);
    },
  };
}
