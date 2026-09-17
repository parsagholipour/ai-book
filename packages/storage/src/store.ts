import {
  CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand,
  HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client
} from "@aws-sdk/client-s3";

export type ObjectMetadata = { size: number; lastModified?: Date; contentType?: string };
export type StoredObject = ObjectMetadata & { key: string };
export type PutOptions = { contentType?: string };
export interface ObjectStore {
  /** Resolves once the bucket answers with this process's credentials; writes nothing. Rejects with the cause otherwise. */
  ready(): Promise<void>;
  put(key: string, data: Buffer | string, options?: PutOptions): Promise<void>;
  putIfAbsent(key: string, data: Buffer | string, options?: PutOptions): Promise<boolean>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<ObjectMetadata | null>;
  list(prefix: string): Promise<StoredObject[]>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
}

export type S3StorageConfig = { bucket: string; region: string; endpoint?: string; forcePathStyle?: boolean };
export function storageConfig(env: NodeJS.ProcessEnv = process.env): S3StorageConfig {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket && env.NODE_ENV === "production") throw new Error("S3_BUCKET is required in production.");
  const rawPathStyle = env.S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  if (rawPathStyle && !["true", "false", "1", "0", "yes", "no", "on", "off"].includes(rawPathStyle)) {
    throw new Error("S3_FORCE_PATH_STYLE must be true or false.");
  }
  return {
    bucket: bucket || "ai-book-maker",
    region: env.S3_REGION?.trim() || env.AWS_REGION?.trim() || "us-east-1",
    ...(env.S3_ENDPOINT?.trim() ? { endpoint: env.S3_ENDPOINT.trim() } : {}),
    forcePathStyle: ["true", "1", "yes", "on"].includes(rawPathStyle ?? "")
  };
}

export function validateObjectKey(key: string): string {
  if (!key || key.startsWith("/") || key.includes("\\") || /[\x00-\x1f]/.test(key)
      || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid object key: ${key}`);
  }
  return key;
}
export type StorageCategory = "books" | "images" | "voice" | "audio" | "attachments";
export function objectKey(category: StorageCategory, ...parts: string[]): string {
  if (parts.some((part) => part.includes("/") || part.includes("\\"))) throw new Error("Object key parts must be individual segments.");
  return validateObjectKey([category, ...parts].join("/"));
}
function validatedPrefix(prefix: string): string {
  validateObjectKey(prefix.replace(/\/$/, ""));
  return prefix;
}
function isMissing(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (value?.name === "NoSuchBucket") return false;
  return value?.name === "NoSuchKey" || value?.name === "NotFound" || value?.$metadata?.httpStatusCode === 404;
}

/** Private bucket I/O. Credentials always come from the AWS SDK default chain. */
export class S3ObjectStore implements ObjectStore {
  readonly client: S3Client;
  constructor(readonly config: S3StorageConfig, client?: S3Client) {
    this.client = client ?? new S3Client({
      region: config.region, ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? false
    });
  }
  /**
   * A HeadBucket needs `s3:ListBucket`, so it proves the bucket exists, the region is right, and the
   * credential chain (the EC2 role in production, static MinIO keys locally) resolved — everything a
   * misdeployment gets wrong. Both entry points run it before serving, so the failure is a refused
   * start rather than the first upload.
   */
  async ready(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch (error) {
      const where = this.config.endpoint ?? `region ${this.config.region}`;
      throw new Error(`Object storage bucket "${this.config.bucket}" is not reachable at ${where}: ${(error as Error).message}`, { cause: error });
    }
  }
  async put(key: string, data: Buffer | string, options: PutOptions = {}): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: validateObjectKey(key), Body: data,
      ...(options.contentType ? { ContentType: options.contentType } : {}) }));
  }
  async putIfAbsent(key: string, data: Buffer | string, options: PutOptions = {}): Promise<boolean> {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: validateObjectKey(key), Body: data,
        IfNoneMatch: "*", ...(options.contentType ? { ContentType: options.contentType } : {}) }));
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) return false;
      throw error;
    }
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: validateObjectKey(key) }));
      if (!result.Body) throw new Error(`S3 returned no body for ${key}`);
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async head(key: string): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: validateObjectKey(key) }));
      return { size: result.ContentLength ?? 0, ...(result.LastModified ? { lastModified: result.LastModified } : {}),
        ...(result.ContentType ? { contentType: result.ContentType } : {}) };
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async list(prefix: string): Promise<StoredObject[]> {
    validatedPrefix(prefix);
    const objects: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix,
        ...(cursor ? { ContinuationToken: cursor } : {}) }));
      for (const item of page.Contents ?? []) {
        if (item.Key) objects.push({ key: item.Key, size: item.Size ?? 0,
          ...(item.LastModified ? { lastModified: item.LastModified } : {}) });
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !cursor) throw new Error("S3 list response is truncated without a continuation token.");
    } while (cursor);
    return objects;
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: validateObjectKey(key) }));
  }
  async deletePrefix(prefix: string): Promise<void> {
    // A subtree boundary prevents deleting project `abc-other` when deleting `abc`.
    const objects = await this.list(`${validatedPrefix(prefix).replace(/\/$/, "")}/`);
    for (let offset = 0; offset < objects.length; offset += 1000) {
      const result = await this.client.send(new DeleteObjectsCommand({ Bucket: this.config.bucket,
        Delete: { Objects: objects.slice(offset, offset + 1000).map(({ key }) => ({ Key: key })), Quiet: true } }));
      if (result.Errors?.length) throw new Error(`S3 deletion failed: ${result.Errors.map((e) => `${e.Key}: ${e.Code}`).join(", ")}`);
    }
  }
  async copy(from: string, to: string): Promise<void> {
    await this.client.send(new CopyObjectCommand({ Bucket: this.config.bucket, Key: validateObjectKey(to),
      CopySource: [this.config.bucket, ...validateObjectKey(from).split("/")].map(encodeURIComponent).join("/") }));
  }
}
let activeStore: ObjectStore | undefined;
export function objectStore(): ObjectStore { return activeStore ??= new S3ObjectStore(storageConfig()); }
/** Explicit test injection only; production never selects a filesystem or memory backend. */
export function setObjectStoreForTests(store: ObjectStore | null): void { activeStore = store ?? undefined; }
