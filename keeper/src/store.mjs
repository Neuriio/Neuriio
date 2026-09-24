// Tiny crash-safe JSON store: writes to a temp file then renames, so a crash mid-write can
// never leave a half-written state file (the relayer's write-ahead log depends on this).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export class JsonStore {
  constructor(path) {
    this.path = path;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }

  save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

export class MemoryStore {
  constructor(data = {}) {
    this.data = data;
    this.saves = 0;
  }

  save() {
    this.saves++;
  }
}
