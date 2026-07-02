import fs from 'node:fs/promises';
import path from 'node:path';
import { type MediaPoolImport, MemoryStore } from './memoryStore.ts';

/** {@link MemoryStore} that mirrors every mutation to a JSON file on disk. */
export class FileStore extends MemoryStore {
  private readonly filePath: string;
  private savePromise: Promise<void> = Promise.resolve();
  private saveCounter = 0;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.importMediaPool(JSON.parse(raw) as MediaPoolImport);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.save();
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load media pool from ${this.filePath}: ${message}`);
    }
  }

  protected override persist(): Promise<void> {
    return this.save();
  }

  /**
   * Serialise writes so concurrent updates never rename the same temp file out
   * from under each other. Each queued write exports a fresh snapshot, so the
   * latest in-memory state always wins.
   */
  private save(): Promise<void> {
    this.savePromise = this.savePromise.catch(() => {}).then(() => this.writeFile());
    return this.savePromise;
  }

  private async writeFile(): Promise<void> {
    this.saveCounter += 1;
    const temporaryPath = `${this.filePath}.${process.pid}.${this.saveCounter}.tmp`;
    const data = JSON.stringify(this.exportMediaPool(), null, 2);

    // Atomic replace keeps the pool readable even if the process stops mid-save.
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(temporaryPath, `${data}\n`, 'utf8');
    await fs.rename(temporaryPath, this.filePath);
  }
}
