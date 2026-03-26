import { Command } from 'commander';

export function main(): void {
  const program = new Command();

  program
    .name('spec-monkey')
    .description('Unattended AI-driven development automation CLI')
    .version('0.1.0');

  program.parse(process.argv);
}
