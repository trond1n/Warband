import { RUNNER_IDS, RUNNERS } from './runners/registry.ts';

const HELP = `warband <command>

Commands:
  doctor   Show which agent CLIs are installed and what Warband assumes about them
  help     Show this message
`;

async function doctor(): Promise<number> {
  const rows = await Promise.all(
    RUNNER_IDS.map(async (id) => {
      const runner = RUNNERS[id];
      const detection = await runner.detect();
      return {
        CLI: runner.displayName,
        binary: runner.binary,
        installed: detection.found ? 'yes' : 'no',
        version: detection.version ?? '',
        sandbox: runner.capabilities.sandbox,
        'headless approvals': runner.capabilities.headlessApprovals,
        verified: runner.capabilities.verified ? 'yes' : 'no',
        note: detection.found ? (detection.problem ?? '') : 'not on PATH',
      };
    }),
  );
  console.table(rows);
  console.log('Login state is not checked here. Run `npm run spike` to test a real headless call.');
  return rows.some((row) => row.installed === 'yes') ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'help';
  switch (command) {
    case 'doctor':
      return doctor();
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
