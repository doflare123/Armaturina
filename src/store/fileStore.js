import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore } from './memoryStore.js';

class FileStore extends MemoryStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.savePromise = Promise.resolve();
    this.saveCounter = 0;
  }

  async load() {
    try {
      const rawData = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(rawData);

      this.importMediaPool(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.save();
        return;
      }

      throw new Error(`Failed to load media pool from ${this.filePath}: ${error.message}`);
    }
  }

  save() {
    // Serialize writes so concurrent updates can never rename the same temp
    // file out from under each other. Each queued write exports a fresh
    // snapshot, so callers always persist the latest in-memory state.
    this.savePromise = this.savePromise
      .catch(() => {})
      .then(() => this.writeFile());

    return this.savePromise;
  }

  async writeFile() {
    const directoryPath = path.dirname(this.filePath);
    this.saveCounter += 1;
    const temporaryPath = `${this.filePath}.${process.pid}.${this.saveCounter}.tmp`;
    const data = JSON.stringify(this.exportMediaPool(), null, 2);

    // Atomic replace keeps the pool readable even if the process stops mid-save.
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(temporaryPath, `${data}\n`, 'utf8');
    await fs.rename(temporaryPath, this.filePath);
  }

  async addStickerSet(setName, stickers, pool = 'regular', metadataByFileId = new Map()) {
    const addedCount = super.addStickerSet(setName, stickers, pool, metadataByFileId);
    await this.save();

    return addedCount;
  }

  async addAnimation(fileId, pool = 'regular', metadata = {}) {
    super.addAnimation(fileId, pool, metadata);
    await this.save();
  }

  async updateMediaMetadata(fileId, pool = 'regular', metadata = {}) {
    const updated = super.updateMediaMetadata(fileId, pool, metadata);

    if (updated) {
      await this.save();
    }

    return updated;
  }

  async recordHit(chatId, target, isUltra = false) {
    super.recordHit(chatId, target, isUltra);
    await this.save();
  }

  async recordLef(chatId, target) {
    super.recordLef(chatId, target);
    await this.save();
  }

  async recordModerationAbuse(chatId, user, now = Date.now()) {
    const result = super.recordModerationAbuse(chatId, user, now);
    await this.save();

    return result;
  }
}

export {
  FileStore
};
