import fs from "node:fs/promises";
import path from "node:path";
import { localDataDirectory } from "../config.js";
import { dpapi } from "./dpapi.js";
import type { MonarchSession } from "./types.js";

export interface Cipher {
  encrypt(value: Buffer): Promise<Buffer>;
  decrypt(value: Buffer): Promise<Buffer>;
}

export class SessionStore {
  readonly file: string;
  constructor(
    private readonly cipher: Cipher = dpapi,
    directory = localDataDirectory(),
  ) {
    this.file = path.join(directory, "auth.bin");
  }
  private queue: Promise<unknown> = Promise.resolve();
  /** Serialise file access so a reader never sees a half-written session. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
  save(session: MonarchSession): Promise<void> {
    return this.exclusive(async () => {
      const text = JSON.stringify(session);
      const encrypted = await this.cipher.encrypt(Buffer.from(text, "utf8"));
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, encrypted, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
  }
  load(): Promise<MonarchSession | undefined> {
    return this.exclusive(() => this.loadUnlocked());
  }
  private async loadUnlocked(): Promise<MonarchSession | undefined> {
    try {
      const encrypted = await fs.readFile(this.file);
      const plain = await this.cipher.decrypt(encrypted);
      const candidate: unknown = JSON.parse(plain.toString("utf8"));
      if (!candidate || typeof candidate !== "object")
        throw new Error("DPAPI_FAILED");
      const session = candidate as MonarchSession;
      if (!session.capturedAt || (!session.cookie && !session.authorization))
        throw new Error("DPAPI_FAILED");
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await fs.rm(this.file, { force: true });
      throw new Error("DPAPI_FAILED");
    }
  }
  clear(): Promise<void> {
    return this.exclusive(() => fs.rm(this.file, { force: true }));
  }
}
