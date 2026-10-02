import { Command, CommanderError } from 'commander';
import { ApiClient } from './client.js';
import { auditCommands } from './commands/audit.js';
import { assignmentCommands } from './commands/assignments.js';
import { authCommands } from './commands/auth.js';
import { configCommands } from './commands/config.js';
import { crewCommands } from './commands/crew.js';
import { inboxCommands } from './commands/inbox.js';
import { missionCommands } from './commands/missions.js';
import { orgCommands } from './commands/org.js';
import { profileCommands } from './commands/profile.js';
import { platformCommands } from './commands/platform.js';
import { skillCommands } from './commands/skills.js';
import { userCommands } from './commands/users.js';
import type { Context } from './context.js';
import { CliError, ExitCode } from './errors.js';
import type { CliDeps } from './io.js';

/** Builds the `mc` program. Authorisation is the server's job; the CLI only parses, prompts and prints. */
export function buildProgram(deps: CliDeps): Command {
  const ctx: Context = { deps, client: new ApiClient(deps.store, deps.fetch) };
  const program = new Command('mc')
    .description('Mission Control command line')
    .option('--json', 'print machine-readable JSON')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => deps.stdout.write(text),
      writeErr: (text) => deps.stderr.write(text),
    });
  configCommands(program, ctx);
  authCommands(program, ctx);
  platformCommands(program, ctx);
  userCommands(program, ctx);
  orgCommands(program, ctx);
  skillCommands(program, ctx);
  auditCommands(program, ctx);
  crewCommands(program, ctx);
  profileCommands(program, ctx);
  missionCommands(program, ctx);
  assignmentCommands(program, ctx);
  inboxCommands(program, ctx);
  // Subcommands inherit the output configuration and exit behaviour.
  for (const sub of program.commands) inherit(sub, program);
  return program;
}

function inherit(command: Command, parent: Command): void {
  command.exitOverride().configureOutput(parent.configureOutput());
  command.showHelpAfterError();
  for (const sub of command.commands) inherit(sub, command);
}

/** Runs the CLI and returns the process exit code (DESIGN.md §14). */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const program = buildProgram(deps);
  const json = argv.includes('--json');
  try {
    await program.parseAsync(argv, { from: 'user' });
    return ExitCode.OK;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version are not failures; anything else is a usage error.
      return error.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
    }
    if (error instanceof CliError) {
      deps.stderr.write(
        json
          ? `${JSON.stringify({ error: error.problem ?? { message: error.message } })}\n`
          : `Error: ${error.message}\n`,
      );
      return error.exitCode;
    }
    deps.stderr.write(`Error: ${(error as Error).message}\n`);
    return ExitCode.SERVER;
  }
}
