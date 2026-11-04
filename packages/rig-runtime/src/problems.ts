/** One finding of a check. `code` is stable and machine readable. `message` explains the finding in English. */
export type Problem = { readonly code: string; readonly message: string; readonly subject?: string };

/** An error that carries one or more problems. The first problem gives the error code. */
export class RigRuntimeError extends Error {
  readonly code: string;
  readonly problems: readonly Problem[];

  constructor(problems: readonly Problem[]) {
    const first = problems[0] ?? { code: 'E_UNKNOWN', message: 'Unknown error.' };
    super(problems.map((problem) => `${problem.code}: ${problem.message}`).join('\n'));
    this.name = 'RigRuntimeError';
    this.code = first.code;
    this.problems = problems;
  }
}

/** Makes a problem. */
export function problem(code: string, message: string, subject?: string): Problem {
  return subject === undefined ? { code, message } : { code, message, subject };
}

/** Throws a RigRuntimeError when the list is not empty. */
export function throwIfAny(problems: readonly Problem[]): void {
  if (problems.length > 0) throw new RigRuntimeError(problems);
}

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Prints a value for an error message. Untrusted text is cut and limited to printable ASCII. */
export function show(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const cut = text.length > 80 ? `${text.slice(0, 80)}...` : text;
  return JSON.stringify(cut.replace(/[^\x20-\x7e]/g, '?'));
}
