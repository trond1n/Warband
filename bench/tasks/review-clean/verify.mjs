// review-clean: the change is clean, so the reviewer approves it with no
// finding of severity high or medium. Low findings (optional notes) do not
// fail the task; a finding without a severity counts as medium. Whether
// there were any findings at all is the separate expectation
// review_findings_max = 0 in task.toml.
import { events, fail, findingText, pass, reviews } from '../verify-lib.mjs';

const [first] = reviews(events());
if (!first) fail('the reviewer gave no verdict');
if (first.verdict !== 'approve') fail(`the reviewer asked for changes:\n${first.findings.map(findingText).join('\n')}`);
const serious = first.findings.filter((f) => f.severity !== 'low');
if (serious.length > 0) {
  fail(`approved, with findings above low on a clean change:\n${serious.map((f) => `[${f.severity ?? 'no severity, counted as medium'}] ${findingText(f)}`).join('\n')}`);
}
pass(first.findings.length === 0 ? 'approved without findings' : `approved; ${first.findings.length} low finding(s) only`);
