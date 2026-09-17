import { validateObjectKey, type ObjectStore, type ObjectMetadata, type StoredObject, type PutOptions } from "./store.js";
/** Explicit in-memory test double; never selected by environment or production code. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly metadata = new Map<string, ObjectMetadata>();
  async ready(): Promise<void> {}
  async put(key: string, data: Buffer | string, options: PutOptions = {}): Promise<void> {
    validateObjectKey(key);
    const bytes = Buffer.from(data); this.objects.set(key, bytes);
    this.metadata.set(key, { size: bytes.length, lastModified: new Date(), ...options });
  }
  async putIfAbsent(key: string, data: Buffer | string, options?: PutOptions): Promise<boolean> {
    if (this.objects.has(validateObjectKey(key))) return false;
    await this.put(key,data,options); return true;
  }
  async get(key: string): Promise<Buffer | null> { const bytes = this.objects.get(validateObjectKey(key)); return bytes ? Buffer.from(bytes) : null; }
  async head(key: string): Promise<ObjectMetadata | null> { return this.metadata.get(validateObjectKey(key)) ?? null; }
  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.length, ...this.metadata.get(key) })).sort((a,b)=>a.key.localeCompare(b.key));
  }
  async delete(key: string): Promise<void> { validateObjectKey(key); this.objects.delete(key); this.metadata.delete(key); }
  async deletePrefix(prefix: string): Promise<void> { for(const entry of await this.list(`${prefix.replace(/\/$/, "")}/`)) await this.delete(entry.key); }
  async copy(from: string, to: string): Promise<void> {
    const bytes = await this.get(from); if (!bytes) throw Object.assign(new Error(`Missing ${from}`), { name: "NoSuchKey" });
    const metadata = this.metadata.get(from); await this.put(to, bytes, metadata?.contentType ? { contentType: metadata.contentType } : {});
  }
}
