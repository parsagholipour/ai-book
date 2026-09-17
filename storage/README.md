# Historical local storage

Durable application data now lives in private S3 (MinIO in development). Existing files in this directory are historical and are neither migrated nor read as a fallback.

See [docs/storage.md](../docs/storage.md) for object keys, authenticated downloads, run-log inspection, and local temporary work. New durable reads and writes use `@book-maker/storage`.
