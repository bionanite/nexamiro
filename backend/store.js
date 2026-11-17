import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A single-process store. Writes are serialized and atomically replace a snapshot. */
export async function createStore(dataDir, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const directory = resolve(dataDir);
  const filename = join(directory, 'workspace.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let state = { version: 1, tasks: [], documents: [] };
  try {
    const bytes = await readFile(filename);
    if (bytes.length > maxBytes) throw new Error('Workspace exceeds the supported storage size.');
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.documents)) {
      throw new Error('Unsupported workspace format.');
    }
    state = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('Cannot read workspace data; the existing file has been preserved.', { cause: error });
    }
  }

  let writes = Promise.resolve();
  return {
    state,
    save({ reserveBytes = 0 } = {}) {
      // Capture before enqueueing: later in-memory changes cannot alter this write.
      const content = JSON.stringify(state);
      if (Buffer.byteLength(content, 'utf8') > maxBytes - reserveBytes) {
        const error = new Error('Workspace storage is full. Remove unused documents or archive the data directory before adding more work.');
        error.statusCode = 409;
        error.code = 'WORKSPACE_FULL';
        throw error;
      }
      const operation = writes.catch(() => {}).then(async () => {
        const temporary = join(directory, `.workspace-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
          await rename(temporary, filename);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      });
      writes = operation;
      return operation;
    },
    flush() { return writes; },
  };
}
