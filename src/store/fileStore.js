import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore } from './memoryStore.js';

class FileStore extends MemoryStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
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

  async save() {
    const directoryPath = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
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
}

export {
  FileStore
};
