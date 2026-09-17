import { MemoryObjectStore, setObjectStoreForTests } from "@book-maker/storage";

export const testObjectStore = new MemoryObjectStore();

export function resetTestObjectStore(): void {
  testObjectStore.objects.clear();
  testObjectStore.metadata.clear();
  setObjectStoreForTests(testObjectStore);
}

/** Synchronous fixture seeding keeps existing DB race callbacks deterministic. */
export function seedObject(key: string, bytes: Buffer | string, modifiedAt = new Date()): void {
  const value = Buffer.from(bytes);
  testObjectStore.objects.set(key, value);
  testObjectStore.metadata.set(key, { size: value.length, lastModified: modifiedAt });
}

export function readObjectText(key: string): string {
  const bytes = testObjectStore.objects.get(key);
  if (!bytes) throw new Error(`Missing fixture object: ${key}`);
  return bytes.toString("utf8");
}

export function objectNames(prefix: string): string[] {
  return [...testObjectStore.objects.keys()].filter((key) => key.startsWith(`${prefix}/`)).map((key) => key.slice(prefix.length + 1)).sort();
}
