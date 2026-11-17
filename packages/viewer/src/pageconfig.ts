// Pure functions of the viewer page. They have no DOM access, so the tests run them in Node.js.

export type PageConfig = {
  readonly skeleton: string;
  readonly atlas: string;
  readonly animations: readonly string[];
  readonly required: readonly string[];
};

/** Relative URL of an export file: `export/<plain file name>`. No scheme, host, query, or parent folder. */
const relativeExportUrl = /^export\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isControl = (code: number): boolean => code < 32 || code === 127;
const hasControl = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) if (isControl(text.charCodeAt(index))) return true;
  return false;
};
const isAnimationName = (value: unknown): boolean => typeof value === 'string' && value.length >= 1 && value.length <= 128 && !hasControl(value);

/** Checks the `viewer.json` data from the server. It returns the problem text, or the configuration. */
export function parsePageConfig(value: unknown): PageConfig | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'viewer.json is not a JSON object.';
  const record = value as Record<string, unknown>;
  const { skeleton, atlas, animations, required } = record;
  if (typeof skeleton !== 'string' || !relativeExportUrl.test(skeleton)) return 'viewer.json has no valid skeleton URL.';
  if (typeof atlas !== 'string' || !relativeExportUrl.test(atlas)) return 'viewer.json has no valid atlas URL.';
  const names = (list: unknown): string[] | null => (Array.isArray(list) && list.length <= 256 && list.every(isAnimationName) ? (list as string[]) : null);
  const all = names(animations);
  const needed = names(required);
  if (all === null || needed === null) return 'viewer.json has no valid animation list.';
  const missing = needed.filter((name) => !all.includes(name));
  if (missing.length > 0) return `The skeleton has no animation ${missing.join(', ')}.`;
  return { skeleton, atlas, animations: all, required: needed };
}

/** The status line text for a load error. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error.';
  let clean = '';
  for (let index = 0; index < message.length && index < 600; index += 1) {
    const code = message.charCodeAt(index);
    clean += code !== 10 && isControl(code) ? '?' : message.charAt(index);
  }
  return `Error: ${clean.slice(0, 600)}`;
}

/** Waits for a promise for at most `ms` milliseconds. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
