# Durable storage

`@book-maker/storage` is the shared private S3 boundary for the API, worker, and operations scripts. Production uses the configured AWS bucket and the AWS SDK credential chain (the EC2 role in this deployment). Development uses the MinIO service in Compose. Copy the S3 settings from `.env.example` into an existing local `.env` before running host processes; host processes use `http://localhost:9000`, containers use `http://minio:9000`.

`S3_BUCKET` is required in production. `S3_REGION`, optional `S3_ENDPOINT`, and `S3_FORCE_PATH_STYLE` configure the client. Local MinIO uses `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; production uses the role without static credentials. The application never creates buckets, changes ACLs, or serves public S3 URLs. Provisioning and deployment are described in [deployment.md](deployment.md).

Both the API and the worker call `objectStore().ready()` — a `HeadBucket` — before serving or claiming a job, and exit when it fails. A wrong bucket, region or endpoint, or a credential chain that does not resolve, is therefore a container that refuses to start and fails the deployment's health wait, not a book that fails at its first upload. Locally it means MinIO is not running: `docker compose up -d minio-init`.

## Ownership and object keys

Database records still establish ownership and entitlement. Existing authenticated asset and download routes check those records before reading S3 and return the bytes themselves. Export renderers require the owning project when reading S3 illustrations; markdown cannot pull another project's images into an export. `object://` references are internal provider inputs constructed from validated keys, not public download URLs.

| Prefix | Contents |
| --- | --- |
| `books/<projectId>/` | Manuscript, PDF/EPUB/DOCX, provenance, reader chapter cache |
| `books/.export-backups/<projectId>/` | Export predecessors awaiting cleanup |
| `books/<projectId>/runs/` | Provider calls and other durable generation diagnostics |
| `images/<projectId>/` | Covers, page illustrations, reference sheets |
| `images/characters/<userId>/` | Retained character photos and portraits |
| `voice/<projectId>/` | Generated operator voice replies |
| `audio/<projectId>/` | Audiobook chapters and timing data |
| `audio/samples/` | Generated narrator samples; bundled release samples remain application assets |
| `attachments/<draftId>/` | Uploaded originals, including import sources |

Construct keys with `objectKey(category, ...segments)`. Object operations are `put`, `putIfAbsent`, `get`, `head`, `list`, `copy`, `delete`, and `deletePrefix`. Missing objects return `null` from `get`/`head`; access, network, and provisioning errors propagate. `putIfAbsent` protects upload request IDs across concurrent retries. Prefix deletion always uses a subtree boundary. Listing follows every S3 continuation token, and bulk deletion checks per-object errors.

Export publication retains the existing database revision fence and project lock. Pending render outputs stay local; publication copies predecessor objects to private backup keys, puts new bytes, and restores predecessors when the transaction fails. The provenance digest identifies the exact bytes returned even if a reader overlaps publication. Superseded objects are removed after success and old abandoned backups are swept from their dedicated prefix, without scanning book content or run logs. There is no multi-object S3 transaction; the database fence and digest checks remain necessary.

Run-log appends each write an immutable JSON event under `<run-key>.events/`. This preserves concurrent appends without pretending S3 supports file append. Use `readRunLog(runKey)` to reconstruct JSONL and `listRunLogs(projectId)` to discover runs. The plan repair, development rerun, worker provenance probe, and adherence replay tools use these helpers. `--log-file` on the repair tool now names an S3 run key. `.scratch/` experiment reports and checked-in fixture inputs stay local.

## Local scratch and tests

`withTemporaryDirectory` and `withObjectFiles` provide scoped local files for Chromium and tools requiring filenames. Renderers copy only the requested project's referenced illustrations into a private temporary directory. `finally` removes it after success or failure. A heartbeat marker protects active work; each process sweeps old abandoned helper directories after crashes. The API and worker have separate scratch filesystems. `BOOK_STORAGE_DIR`, `IMAGE_STORAGE_DIR`, `VOICE_STORAGE_DIR`, `AUDIO_STORAGE_DIR`, and `ATTACHMENT_STORAGE_DIR` are compatibility configuration for scratch/offline callers, never a durable storage backend.

Some compatibility helper names still contain `Path` or accept an unused old root parameter (for example `creationAttachmentFilePath` and `exportProvenancePath`). Their durable return values are object keys. New code should use explicit key names and `exportProvenanceKey`; never pass these values to filesystem functions. `libraryCharacterDiskPath` is for explicit local fixtures; production uses `libraryCharacterObjectKey`.

Tests inject `MemoryObjectStore` explicitly. Production never selects it from environment settings and never falls back to local disk. Offline source evaluation scripts inject it to keep their synthetic uploads isolated. The storage package's optional integration suite exercises a real private MinIO bucket, including multi-client reads, conditional writes, more than 1,000 keys, and anonymous denial:

```sh
S3_INTEGRATION=true pnpm -F @book-maker/storage test
```

Set the S3 and AWS environment variables to a disposable MinIO instance first. The suite deletes only its generated test prefix. Existing files under `storage/` are historical; there is no migration or legacy read fallback. Preserve or remove those files explicitly according to your own retention needs.
