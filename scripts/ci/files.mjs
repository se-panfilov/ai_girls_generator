import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

// Read a regular file through one file descriptor, so that the checked file is the file that is read.
// A missing file returns undefined. A link, a directory, or a file larger than the limit is an error.
// An encoding of null returns a Buffer.
export function readRegularFile(path, limit = 16 * 1024 * 1024, encoding = 'utf8') {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'ELOOP') throw new Error(`Expected a regular file, not a link: ${path}`, { cause: error });
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    if (stat.size > limit) throw new Error(`The file is too large: ${path}`);
    return readFileSync(descriptor, encoding);
  } finally {
    closeSync(descriptor);
  }
}
