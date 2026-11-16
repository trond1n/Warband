// review-clean: the change is clean, so the reviewer approves it without
// findings.
import { events, fail, findingText, pass, reviews } from '../verify-lib.mjs';

const [first] = reviews(events());
if (!first) fail('the reviewer gave no verdict');
if (first.verdict !== 'approve') fail(`the reviewer asked for changes:\n${first.findings.map(findingText).join('\n')}`);
if (first.findings.length > 0) fail(`approved, with findings on a clean change:\n${first.findings.map(findingText).join('\n')}`);
pass('approved without findings');
