import { spawn } from 'node:child_process';

/**
 * Runs a command without a shell, so arguments are never interpreted.
 * Resolves with the exit code and output; never rejects for a non-zero exit code.
 */
export function run(command, args, { input, cwd } = {}) {
  return new Promise((resolve) => {
    // stdin is only opened when there is something to send; a closed stdin cannot raise EPIPE
    const child = spawn(command, args, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // Decoded as a stream, so a character split between two chunks stays whole
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) {
      // A command that exits without reading its input must not crash the setup
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** Runs a command and throws with its error output when it fails. */
export async function runOrThrow(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}
