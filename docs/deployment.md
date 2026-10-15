# Docker deployment on AWS

Every push to `master` runs the Terraform workflow, applies infrastructure, then
calls `deploy.yml` to build and deploy the **same commit**, unless every file the
push changes is under `docs/`, `apps/mobile/`, `.scratch/` or `.claude/`, or is a
Markdown file (`paths-ignore`: none of those reach an image or the infrastructure,
and every deploy is a short outage). A push that changes any other file deploys,
whatever else it also changes. You can also run
**Actions → Terraform → Run workflow** on `master`. Pull requests only plan
infrastructure and never deploy. GitHub serializes the full apply/deploy workflow;
it does not cancel an active production deployment when another commit arrives.

The API and worker run in separate containers using the shared `app` Docker
target. The `web` target serves Vite's production build through Nginx and proxies
`/api`, `/docs`, and generated assets to the API. Browser requests use the same
origin, so no build-time API URL is needed. A `caddy` container is the only
service with host ports: it owns 80 and 443 on the instance's Elastic IP,
terminates TLS for **https://tomeza.ravanix.app** with a Let's Encrypt certificate,
and forwards to Nginx, which stays HTTP-only on the private Compose network
alongside PostgreSQL/pgvector and Redis. Durable files live in a private S3 bucket
provisioned by Terraform. API and worker containers have separate disposable
scratch directories and share files through S3.

## One-time setup

1. Keep the existing repository secrets `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY`. The AWS principal must have the existing Terraform
   permissions plus permission to create/configure the S3 assets bucket (including
   `s3:GetBucketVersioning` and `s3:PutBucketVersioning`, and the lifecycle configuration),
   create ECR repositories, manage/pass the EC2
   IAM role, allocate/associate an Elastic IP (`ec2:AllocateAddress`,
   `ec2:AssociateAddress`, `ec2:DisassociateAddress`, `ec2:ReleaseAddress`,
   `ec2:DescribeAddresses`), push ECR images, write the `/book-maker/production/env` SSM parameter,
   and call `ssm:DescribeInstanceInformation`, `ssm:SendCommand` (the
   `AWS-RunShellScript` document and the EC2 instance), and
   `ssm:GetCommandInvocation`. Terraform's root-filesystem and swap preparation also need
   `ssm:CreateAssociation`, `ssm:DescribeAssociation`, `ssm:DeleteAssociation`,
   `ssm:ListTagsForResource`, `ssm:AddTagsToResource`, and `ssm:RemoveTagsFromResource`
   for their associations and the `AWS-RunShellScript` document. ECR push uses `ecr:GetAuthorizationToken`,
   `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`,
   `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, and `ecr:PutImage`. The repositories'
   lifecycle policy needs `ecr:PutLifecyclePolicy`, `ecr:GetLifecyclePolicy`, and
   `ecr:DeleteLifecyclePolicy`. The alarms in `monitoring.tf` need `sns:CreateTopic`,
   `sns:DeleteTopic`, `sns:GetTopicAttributes`, `sns:SetTopicAttributes`,
   `sns:ListTagsForResource`, `sns:Subscribe`, `sns:Unsubscribe`,
   `sns:GetSubscriptionAttributes`, `sns:SetSubscriptionAttributes` and
   `sns:ListSubscriptionsByTopic`; `cloudwatch:PutMetricAlarm`, `cloudwatch:DescribeAlarms`,
   `cloudwatch:DeleteAlarms` and `cloudwatch:ListTagsForResource`; and, because two of them
   reboot or recover the instance, `iam:CreateServiceLinkedRole` for
   `events.amazonaws.com` (the `AWSServiceRoleForCloudWatchEvents` role CloudWatch creates
   on the first alarm with an EC2 action).
2. Create the GitHub environment **production**. Add a secret **PRODUCTION_ENV**
   containing the contents of [`deploy/production.env.example`](../deploy/production.env.example)
   with real values. Provider settings from `.env.example` can be included. This
   is Compose `.env` syntax; single-quote values containing literal `$` characters.
   Every setting under [Required settings](#required-settings) must be present, or
   the deploy refuses the release. Use a
   URL-safe database password, e.g. `openssl rand -hex 32`. Do not change it after
   initialization without also rotating the PostgreSQL role password. Caddy → Nginx
   needs `TRUST_PROXY_HOPS=2` (already in the example); production defaults to 2 if
   the secret omits it. Do not put
   deployment overrides such as `APP_IMAGE`, `WEB_IMAGE`, `S3_BUCKET`, or
   `S3_REGION` in this secret. The workflow supplies the bucket and region from
   Terraform. Keep the local MinIO `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, and AWS
   access keys out of `PRODUCTION_ENV`; EC2 uses its instance role for S3.
3. Ensure the instance's AMI has a running **SSM Agent**. Current standard Ubuntu
   and Amazon Linux AMIs generally include it; a custom AMI must install it first.
   Terraform attaches `AmazonSSMManagedInstanceCore`, scoped ECR pull permissions,
   permission to read the environment parameter, and S3 read/write/list/delete
   permissions restricted to the assets bucket. IMDSv2 uses a hop limit of two so
   containers can obtain rotating instance-role credentials. SSM needs outbound HTTPS,
   which the existing network allows. No SSH key or inbound SSH rule is needed.
   The deployment waits up to ten minutes for the instance to become online in
   SSM. Terraform first expands the root partition/filesystem to use the existing
   EBS volume, then creates the swapfile, and waits for both to succeed before the
   build/deploy jobs can start. The
   AMI must include `growpart` and its filesystem tool (`resize2fs` for ext4,
   `xfs_growfs` for XFS). Deployment then installs Docker, Compose, and the AWS CLI
   if absent. The installer
   supports Ubuntu/Debian and Amazon Linux on x86_64.
4. Point DNS at the instance and set `PUBLIC_API_URL=https://tomeza.ravanix.app`.
   See [Public hostname and TLS](#public-hostname-and-tls) below for the exact
   Hetzner record, the secret to update, and the post-DNS check.
5. For book notifications, set up Firebase and add `FCM_SERVICE_ACCOUNT_JSON` to
   `PRODUCTION_ENV`; see [push-notifications.md](push-notifications.md). Without it
   everything else works and no pushes are sent.
6. For alerts, set `OPERATOR_ALERT_EMAIL` in `PRODUCTION_ENV`, add the repository
   variable **ALERT_EMAIL** (Settings → Secrets and variables → Actions → Variables),
   confirm the subscription email AWS sends after the next apply, and point a free
   uptime monitor at `/api/ready`. See [Monitoring and alerts](#monitoring-and-alerts).

## Required settings

In production (`NODE_ENV=production`) the API and the worker refuse to start while any of these is
missing or unusable, and print one error naming every gap and what breaks without it (never a
value). The check is `packages/core/src/productionConfig.ts`; it runs at boot in both processes, so
it covers the Dockerfile/Railway path as well as Compose.

| Setting | Process | Without it |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Compose | Compose refuses the file (`:?` guard). |
| `WEB_PASSWORD` | API | Unset, every request to the console, `/api/admin` and `/docs` is let in as the operator. Must be 16+ characters, not a placeholder such as the example's value; e.g. `openssl rand -hex 24`. |
| `PUBLIC_API_URL` | API, worker | Must be the public `https://` origin. Stored picture, cover and share URLs are built from it, and CORS admits only it. |
| `GOOGLE_PLAY_PACKAGE_NAME` | API | Every purchase answers 503 and is never acknowledged; Google refunds it after three days. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (or `_FILE`) | API | Same. A key with `client_email` and `private_key`; `GOOGLE_PLAY_ACCESS_TOKEN` does not count. |
| `GOOGLE_PLAY_RTDN_AUDIENCE`, `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL` | API | The refund-notice endpoint answers 503, so refunds never take credits back ([google-play-rtdn.md](google-play-rtdn.md)). |
| `SMTP_URL` | API | Forgot-password answers 503 and a reader who forgets their password is locked out. `smtp://` or `smtps://`. Only its shape is checked here; the API then logs in to the server after it starts and every 10 minutes, and a refused login is the `mail` readiness check ([below](#monitoring-and-alerts)), never a refused start. |
| `OPERATOR_ALERT_EMAIL` | API (warned, not required) | Production outages and degradations are only written to the API log; nobody is emailed. One address or a comma-separated list, sent through `SMTP_URL`. See [Monitoring and alerts](#monitoring-and-alerts). |
| Provider keys | API, worker | A book, audiobook or call routed to that provider fails when the call is made. |

**Provider keys are derived from the model routing, not listed by hand.** Every provider the
default routing can select — the compiled text route lists (`compiledGenerationTextRouteCandidates`),
the image defaults and the image fallback rule, narration and voice calls, and Gemini's fixed work
(embeddings, grounded search, OCR) — must have its key (`providerRequirements.ts`). Today that is
`DEEPSEEK_API_KEY`, `DEEPINFRA_API_KEY`, `GEMINI_API_KEY`, `ALIBABA_API_KEY` and `OPENAI_API_KEY`
(the last only while `AUDIOBOOK_OPENAI_FALLBACK_ENABLED` is on, its default). Adding a provider to a
route adds its key to the check. The operator console's Quality tab can save a routing that names
another provider (OpenRouter, Jev's `VERCEL_AI_GATEWAY_API_KEY`); the API and worker log a warning
at boot when a saved route names a provider with no key, rather than refusing, because the route is
moved from the console.

**Logged, not required:** `GOOGLE_SIGN_IN_CLIENT_ID` (Google sign-in answers 503; email sign-in
still works), `FCM_SERVICE_ACCOUNT_JSON` (no push notifications) and `OPERATOR_ALERT_EMAIL` (alerts
only reach the API log). The first two are features a reader can do without; a forgotten password
and a refunded purchase are not. The third is the owner's, and a deploy must not fail over who gets
told when the site breaks — the preflight prints it as a warning instead.

**The deploy checks first.** `scripts/deploy-production.sh` runs the same check in the new image
(`node --import tsx src/checkProductionConfig.ts` in the api service) right after pulling, while the
running release is still serving. A gap fails the GitHub job there, with the list in its output,
instead of stopping the old API and leaving a new one that will not boot.

**The smoke test sets dummy values rather than skipping the check.** `scripts/check-production-docker.sh`
gives the production images fake Play, RTDN, SMTP and password values, runs the preflight once
passing and once with gaps (asserting it names them and prints no value), then boots the stack
through the same check. The only thing waived is the provider keys, because `MOCK_AI` calls no
provider; `ALLOW_MOCK_AI_IN_PRODUCTION=true` is what lets `MOCK_AI` into production, and both
processes log an error at boot whenever it is on. Never put it in `PRODUCTION_ENV`.

**The 8 KB limit.** `PRODUCTION_ENV` is stored as one SSM parameter, which holds at most 8 KB. The
Play and Firebase service-account keys are about 2.3 KB each as Google issues them. The API reads
only `client_email`, `private_key`, `token_uri` and (for Firebase) `project_id`, so a key trimmed to
those fields, minified onto one line, is about 1.8 KB if the secret gets close to the limit.

## Public hostname and TLS

Visitors reach EC2 directly; there is no load balancer, Route 53, ACM, or CDN.

- **Elastic IP.** Terraform allocates an Elastic IP (`aws_eip.book_maker`) and
  associates it with the instance. Read it with `terraform output -raw elastic_ip`
  (the `public_ip` output is the same address); the apply job also prints it at the
  end of the Terraform step. The instance's auto-assigned address is superseded and
  never used. Resizing the instance keeps the Elastic IP. Replacing the instance
  must re-associate **the same** Elastic IP: `aws_eip_association` does that
  automatically when Terraform replaces `aws_instance.book_maker`; if you replace
  the server by hand, associate the existing allocation rather than a new one, or
  the DNS record below goes stale.
- **Security group.** Inbound TCP 80 and 443 from `0.0.0.0/0`, nothing else. Port
  80 exists for the ACME HTTP-01 challenge and the redirect to HTTPS. SSH,
  PostgreSQL, Redis, and the API port are closed; deployment uses SSM. The S3 assets
  bucket stays private. The first plan after this change shows the security group
  being **replaced**: its description changed, which AWS cannot edit in place.
  Terraform creates the new group first, moves the running instance onto it in
  place, then deletes the old one; the instance itself is not replaced.
- **TLS on the instance.** The `caddy` service in
  [`docker-compose.production.yml`](../docker-compose.production.yml) runs
  [`deploy/Caddyfile`](../deploy/Caddyfile): automatic HTTPS for
  `tomeza.ravanix.app` only, `http://` redirected to `https://`, and every request
  reverse-proxied to `web:80` with `Host`, `X-Real-IP`, `X-Forwarded-For`, and
  `X-Forwarded-Proto`. Nginx passes the edge's `X-Real-IP` and `X-Forwarded-Proto`
  on to the API. Request bodies up to 100 MB and the 600 s upstream read timeout
  are enforced once, in `deploy/nginx.conf`; Caddy adds no lower limit and
  disables response buffering like Nginx does for `/api`. Certificates and the
  Let's Encrypt account live in the `caddy-data` volume, so renewals survive
  redeploys; the deploy script never removes volumes. The account contact is
  `ACME_EMAIL` in `PRODUCTION_ENV`, default `support@ravanix.app`. Caddy also
  answers plain HTTP for `Host: 127.0.0.1` from private addresses only, which is
  how the deploy script checks `http://127.0.0.1/api/health` through the whole
  edge without a certificate. No Certbot on the host, no TLS in the web image.
- **One origin.** `https://tomeza.ravanix.app` serves the operator console, `/api`,
  `/docs`, and `/assets/...`. There is no separate API hostname.

### DNS at Hetzner (manual)

The registrar stays GoDaddy and the nameservers stay at Hetzner; do not change
either. `ravanix.app` itself already serves other sites from Hetzner, so touch only
the `tomeza` subdomain:

1. Run the Terraform workflow (or `terraform apply`) and read `elastic_ip`.
2. In Hetzner DNS Console for the `ravanix.app` zone, add or replace one record:
   type **A**, name **tomeza**, value **the Elastic IP**, TTL short (300 s) until it
   works, then raise it if you like.
3. Do **not** add an AAAA record: the instance has no public IPv6.
4. Leave the apex (`@`) and every other record as they are.
5. After the record resolves (`dig +short tomeza.ravanix.app` returns the Elastic
   IP), Caddy obtains the certificate on its own and renews it later. It starts
   trying at container start, so if Caddy was already running before the record
   existed its retries are backing off; `docker compose ... restart caddy` (see
   Operations) forces an immediate attempt. `docker compose ... logs caddy` shows
   `certificate obtained successfully`.

### Switch the app to the hostname

1. In the GitHub environment secret `PRODUCTION_ENV`, set
   `PUBLIC_API_URL=https://tomeza.ravanix.app` (optionally
   `ACME_EMAIL=support@ravanix.app`), then rerun the Terraform workflow or push to
   `master` to redeploy. Image and asset URLs are built from this value.
2. Flutter production builds require an HTTPS API origin:
   `--dart-define=APP_ENV=production --dart-define=API_BASE_URL=https://tomeza.ravanix.app`.
   The legal-page defaults already use this hostname.
3. Post-DNS check: `curl -i https://tomeza.ravanix.app/healthz` returns `ok` with a
   valid certificate, and `curl -i http://tomeza.ravanix.app/` returns a 308 to
   `https://`.

Terraform uses a **t3.medium (4 GiB RAM)** with a **2 GiB swapfile** and a **30 GiB
gp3 disk**. Every container's share of that memory, and the order the kernel kills
them in if it still runs out, is in [Memory budget and swap](#memory-budget-and-swap);
what moving from the earlier t3.small does to the running server is in
[Changing the instance type](#changing-the-instance-type). Worker concurrency still
defaults to one job. The OCR model container is not included on this host: it has
no room in the memory budget. Set `GEMINI_API_KEY` in `PRODUCTION_ENV` to read scanned
PDF pages and images using Google when no local OCR service is configured. If you
also set `SOURCE_OCR_URL` to a private PaddleOCR service, the worker tries it first
and falls back to Google when it fails. Pages handled by the fallback are sent to
Google and incur Gemini API usage. No extra OCR container is needed on EC2.
`GEMINI_OCR_MODEL` optionally overrides `GEMINI_TEXT_MODEL` for OCR. Set
`FULL_DOCUMENT_SOURCES=true` in `PRODUCTION_ENV` if enabling the full-document
source ingestion feature; it remains disabled by default.

The 30 GiB disk holds the OS, the 2 GiB swapfile, Docker images, PostgreSQL, Redis,
and temporary rendering files (see [Image retention and the disk guard](#image-retention-and-the-disk-guard)). The S3 bucket holds generated books, images, audio, voice,
attachments, and durable run artifacts. It blocks public access, requires TLS,
uses SSE-S3 encryption, and aborts unfinished multipart uploads after one day.
Terraform protects it from accidental destruction. Generated books never expire.
The bucket is versioned: a deleted or overwritten object stays recoverable as a
noncurrent version for **30 days** and is then removed by the lifecycle rule, so a
mistaken delete can be undone within a month and an intentional one (a book, an
account, an expired upload) is complete a month later. Old versions of exports a
recompile replaced are billed for those 30 days, cents at launch volume. Database
dumps under `db-backups/` expire after 30 days (see
[Restoring the database before a release](#restoring-the-database-before-a-release)).
Application retention rules still remove expired uploads. See
[storage and inspection](storage.md) for object keys, local MinIO access, and AI
contributor instructions.

To recover a deleted or overwritten object (an operator with AWS credentials, not
the instance):

```bash
aws s3api list-object-versions --bucket "$S3_BUCKET" --prefix books/<projectId>/
# Copy the version you want back over the key; this makes it current again.
aws s3api copy-object --bucket "$S3_BUCKET" --key <key> \
  --copy-source "$S3_BUCKET/<key>?versionId=<versionId>"
```

This is a fresh storage cutover: existing local files are left untouched and are
not migrated or used as a fallback. If the earlier 40 GiB disk setting was already
applied, EBS cannot shrink it in place; retain that size for the existing instance
with GitHub repository variable `ROOT_VOLUME_SIZE=40` (locally,
`TF_VAR_root_volume_size=40`), or provision a fresh 30 GiB instance separately.
The workflow does not replace a server to shrink its disk.

## Release behavior

- GitHub builds on its runner, pushes uniquely tagged images to ECR, and deploys
  immutable image digests. No compilation takes place on the small EC2 instance.
- Before touching EC2, the workflow smoke-tests both images with mock providers,
  a fresh database, migrations, seed data, API/web/worker readiness, and private
  object storage through MinIO. It also recreates the app containers to check that
  objects survive without a shared filesystem, and runs the production config
  preflight both ways (see [Required settings](#required-settings)).
- On EC2, after pulling and before stopping anything, the deploy runs the same
  preflight against `PRODUCTION_ENV` in the new image. A missing required setting
  fails the release with the old one still serving.
- On EC2 the API and worker check that the assets bucket answers a `HeadBucket`
  through the instance role before they serve or take jobs. A missing bucket, a
  wrong region, a broken role, or stray MinIO settings in `PRODUCTION_ENV` leave
  those containers restarting, which fails the health wait and the release.
- Runtime secrets are written to SSM as a `SecureString` using the account's
  default SSM KMS key. Only non-secret scripts and image references enter the SSM
  command. The host retrieves the environment into a root-only `.env` file.
- A host lock prevents overlapping deployment commands. Images are pulled and the
  preflight runs while the running release serves. Then the cutover, in this order:
  1. **The worker drains alone** (`stop worker`, up to its five-minute
     `stop_grace_period`) while the API and web keep serving. It keeps writing its
     heartbeat while it drains, and work the API queues meanwhile waits in Redis
     for the new worker.
  2. **The API and web stop.** The outage starts here.
  3. PostgreSQL and Redis are started (and recreated, if their definition or the
     pgvector image changed), only now, so a recreate never cuts a connection.
  4. **The database is dumped to S3** (`pg_dump --format custom`, streamed to
     `s3://<assets bucket>/db-backups/<UTC time>-<release>.dump`, never through the
     host disk). The URI is printed and written to the release directory's
     `database-dump` file.
  5. Migrations and idempotent seeding run, the new api, worker and web start and
     pass their health checks.

  The outage is steps 2–5: the API's stop (it may wait out open requests, up to
  60 s), the dump (seconds at launch size; it grows with the database), the
  migrations and the start, typically one to two minutes, where the drain used to
  add up to five more. Caddy keeps running and answers 502 meanwhile, so TLS and
  certificate renewal are unaffected; it is recreated once web is healthy, then the
  release is checked with `http://127.0.0.1/api/health` through the edge.
- **What a failure leaves.** Before step 2 (pull, disk guard, preflight, the
  worker's drain): the running release keeps serving. In steps 2–4 (the dump or its
  upload failed, or PostgreSQL did not come up): nothing was migrated, so the
  deploy starts the containers it stopped again, exactly as they were, and fails.
  In step 5 (a failed migration, or a new release that is not healthy): the
  applications stay stopped, because the schema may have changed and the older
  images cannot be trusted on it; the job's output names the dump. Fix forward and
  rerun the workflow, or restore
  ([Restoring the database before a release](#restoring-the-database-before-a-release)).
- Compose's named volumes retain PostgreSQL data, Redis AOF, and Caddy's
  certificates on the instance disk. Data Lifecycle Manager snapshots the instance's
  volumes daily at 03:00 UTC and keeps 14 (`backups.tf`); every deploy also leaves a
  database dump in S3 for 30 days. Snapshot the instance by hand before replacing or
  terminating it. Durable files survive independently in S3. The deploy script
  never deletes volumes or the assets bucket. Losing `caddy-data` only costs a fresh
  certificate request, within Let's Encrypt rate limits.
- Successful releases live under `/opt/book-maker/releases/`; `current` points to
  the last successful one and `previous` to the one before it. The host keeps those
  two releases' images and deletes every other image no container uses; ECR keeps
  the last ten releases. Before pulling, the deploy refuses to continue with less
  than 4 GiB free. See [Image retention and the disk guard](#image-retention-and-the-disk-guard).

## Image retention and the disk guard

One disk holds the OS, every Docker image, and the PostgreSQL and Redis volumes. A
pull that fills it fails halfway, and then PostgreSQL panics on its next WAL write and
Redis fails its AOF writes. The four measures below keep image bytes from getting there.

**Why every deploy used to add about 1 GB.** The `Dockerfile` copied `apps/` and
`packages/` into the image *before* `pnpm install`, so any commit changed the
install step's input. Docker re-ran it and produced a new ~1 GB `node_modules`
layer, with every workspace's dependencies including the dev ones, under a new digest.
A host reuses a layer only when it already has that digest, so each `compose pull`
downloaded and unpacked the gigabyte again. The old copy stayed behind: the deploy
pruned only images *built* more than seven days earlier (`until=168h`), and in launch
week that was none of them. About eight hotfix deploys filled the 20 GiB disk, the
same class of failure as the September 18 incident below. Now both installs run
from the lockfile and the `package.json` files alone. An ordinary commit ships only
the source layers, a few tens of MB, and the host keeps two releases.

- **Layering.** The `manifests` stage reduces the tree to the workspace manifests.
  `build` installs everything for the typecheck, Prisma generate and the Vite build;
  `runtime-deps` installs only the api's and worker's production dependencies
  (`pnpm install --prod --filter "@book-maker/api..." --filter "@book-maker/worker..."`),
  and `app` adds the sources, the generated Prisma client and the console build on
  top. The install layers change only with `pnpm-lock.yaml` or a `package.json`
  (about 1 GB unpacked, 280 MB compressed, when they do) or with the base image.
  `node:22-bookworm-slim` is a moving tag, so a Node or Debian patch release, or a
  GitHub Actions cache eviction, rebuilds the whole image once, about 2 GiB
  unpacked. Pin the base by digest if that should happen only on purpose.
- **Retention on the host.** After a release passes its health checks,
  `scripts/deploy-production.sh` moves `previous` to the outgoing release, unless that
  release ran the same images, as a rerun does. It then deletes every image that no
  container uses and that neither `current/images.env` nor `previous/images.env`
  names, untagged leftovers included. Before pulling, it runs the same cleanup and
  also keeps the incoming release's images, so a host that collected old images
  clears them first and a retried release does not download again. It never removes
  volumes, and a cleanup that cannot read the image list deletes nothing. It does not
  use `docker image prune`: images are pulled by digest and carry no tag, so Docker
  counts the previous release as dangling and prune would delete the rollback. The
  host never builds, so there is no build cache to prune.
- **Disk guard.** The deploy refuses to pull with less than **4 GiB** free and to
  stop the running release with less than **2 GiB** free after the pull. A base-image
  change brings the whole app image, about 2 GiB unpacked plus its compressed blobs
  on a containerd image store, and the databases need room to keep writing while it
  lands. Free space is measured on the fuller of Docker's root directory and
  `/var/lib/containerd`, because the containerd image store keeps layers outside
  `DockerRootDir`. A refusal leaves the running release untouched and prints
  `df` and `docker system df`. Free space without deleting volumes, or raise
  `ROOT_VOLUME_SIZE`, then rerun.
- **ECR.** A lifecycle policy (`aws_ecr_lifecycle_policy.app` in `deployment.tf`)
  keeps the ten most recent tagged images per repository and expires untagged images
  a day after their push. The platform and attestation manifests inside a release's
  image index are untagged, but ECR never expires an image that a manifest list
  references, so a kept release stays pullable. A build whose smoke test fails has
  still pushed, so ten images can mean fewer than ten deployed releases.

To roll back to the previous release's images without ECR, use its own directory:

```bash
cd /opt/book-maker/previous
set -a; . ./images.env; set +a
docker compose --env-file .env -f docker-compose.production.yml up -d --no-deps --wait api worker web
```

Migrations are not reversed, so this is safe only when the newer release changed no
schema the older code reads. When it did (a new enum value is enough: the older
Prisma client throws `Value not found in enum` on the first row that holds it),
restore the dump taken before the newer release's migrations first.

### Restoring the database before a release

Every deploy dumps the database to S3 after stopping the API and before migrating,
so the dump is exactly the state the older release last wrote. Restoring it loses
everything written after that deploy started: accounts, books, credits and
purchases recorded since. A Play purchase recorded and acknowledged in that window
is not lost at Google, but its credits are; restore purchases from the app or grant
them by hand. Redis is not restored: jobs queued after the dump name rows that no
longer exist, and the worker treats a missing row as stopped.

Rehearse this once before launch on a scratch host or database. CI rehearses the
`pg_dump`/`pg_restore` half on every release (`scripts/check-production-docker.sh`).

1. Start an SSM session, `sudo -i`, and pick the release to go back to: after a
   deploy that failed while migrating, `current` still names the release that was
   running; after a deploy that went live, go back to `previous`.

   ```bash
   cd /opt/book-maker/current        # or previous; see above
   set -a; . ./images.env; set +a
   compose="docker compose --env-file .env -f docker-compose.production.yml"
   ```
2. Find the dump. The failed release's directory names it in `database-dump`; or
   list them, newest last:

   ```bash
   cat /opt/book-maker/releases/<failed release>/database-dump
   aws s3 ls "s3://$S3_BUCKET/db-backups/"
   ```
3. Stop the applications (Caddy may keep running), and check the disk: the restore
   briefly holds two copies of the database, and the dump file is a third.

   ```bash
   $compose stop worker api web
   df -h /
   ```
4. Keep the migrated database under another name and restore into a fresh one:

   ```bash
   aws s3 cp "s3://$S3_BUCKET/db-backups/<dump>" /root/restore.dump
   $compose exec -T postgres psql -U bookmaker -d postgres -v ON_ERROR_STOP=1 \
     -c 'ALTER DATABASE bookmaker RENAME TO bookmaker_failed'
   $compose exec -T postgres createdb -U bookmaker bookmaker
   $compose exec -T postgres pg_restore -U bookmaker -d bookmaker --no-owner --exit-on-error \
     < /root/restore.dump
   ```
5. Start the older release from its own directory and check it:

   ```bash
   $compose up -d --no-deps --wait api worker web
   curl --fail http://127.0.0.1/api/health; curl -s http://127.0.0.1/api/ready
   ```

   If the release you went back to is `previous`, point `current` at it
   (`ln -sfn "$(readlink -f /opt/book-maker/previous)" /opt/book-maker/current`)
   so the next deploy's rollback bookkeeping starts from the release that is
   really running.
6. Once it is serving correctly, drop the copy and the file:
   `$compose exec -T postgres dropdb -U bookmaker bookmaker_failed; rm /root/restore.dump`.
   The next deploy of a fixed release migrates the restored database forward again.

If the dump is unusable, the daily EBS snapshot (`backups.tf`) is the older
fallback: create a volume from it in the instance's availability zone, attach it
to the instance, and copy the `book-maker_postgres-data` Docker volume's directory
back with the applications and PostgreSQL stopped. That loses up to a day.

## Memory budget and swap

One instance runs PostgreSQL, Redis, the API and the worker (each a Node process
running TypeScript through tsx, each with its own pooled Chromium), Nginx, Caddy,
Docker and the SSM agent. Until 2026-10 that was a t3.small: 2 GiB, no swap, no
memory limits. A large illustrated compile could start the kernel OOM killer, and if
it picked a PostgreSQL backend the postmaster reset every connection, so in-flight
billing transactions rolled back and running jobs failed. Or the host thrashed and
stopped answering SSM while EC2's status checks still passed. Now every process
either has a ceiling or is protected, and the order the kernel kills in is fixed.

| Service | Ceiling | Node heap | Own swap | `oom_score_adj` | Planned use |
| --- | --- | --- | --- | --- | --- |
| worker | 2 GiB (`mem_limit`) | 768 MiB | none | **+500** | ~0.3 GiB idle, 1–1.5 GiB in a large illustrated compile |
| api | 1 GiB (`mem_limit`) | 512 MiB | none | 0 | ~0.3 GiB |
| postgres | none | | host swap | **−900** | 0.3–0.6 GiB |
| redis | `maxmemory 256mb` | | host swap | **−900** | far under 0.1 GiB at launch |
| web (Nginx) and caddy | none | | host swap | 0 | ~0.1 GiB together |
| OS, Docker, SSM agent | none | | host swap | their own | ~0.4 GiB |

A t3.medium leaves about 3.8 GiB to processes. "Planned use" is an estimate, not a
production measurement; measure it (below) after the first large illustrated compile
and move the numbers if it is wrong. The ceilings plus the rest add up to about
4.4 GiB, so if the API and the worker both hit their ceilings at once, about half a
gigabyte of the other services' coldest pages goes to swap. That is the design: the
databases may get slower, never killed.

- **The API and worker have hard ceilings and no swap of their own**
  (`memswap_limit` equals `mem_limit`), so an overrun is killed by the cgroup inside
  that container and never pages onto the gp3 volume PostgreSQL writes to. Chromium
  is a child process of the Node process (`browserPool.ts`), so it counts against the
  same ceiling. The cgroup kills the largest process in the container: during a
  compile usually a Chromium renderer, which costs that render (`withRenderPage`
  retries a disconnect once), otherwise Node itself, which Docker restarts and whose
  job the queue picks up again. An ops script run with `docker compose exec api`
  shares the API's gigabyte; `docker compose run --rm --no-deps api …` gets its own.
- **Every Node process knows its heap ceiling.** `--max-old-space-size` on each
  service's command line keeps V8 collecting, or failing with "JavaScript heap out
  of memory" in the log, below the container ceiling instead of being SIGKILLed by
  it. Left alone, Node 22 sizes its heap at half the cgroup limit (measured: 1 GiB
  gives 524 MiB, 2 GiB gives 1,048 MiB), which would leave the worker's Chromium less
  room than its heap. The flag is on the command line rather than in `NODE_OPTIONS`
  because the services share one `environment` map through the `x-app` anchor, and a
  command-line flag also wins over a `NODE_OPTIONS` in `PRODUCTION_ENV`. Outside the
  heap, the worker's ~1.2 GiB holds Chromium's browser and up to two renderers
  (`RENDER_CONCURRENCY`), sharp, and every image and PDF buffer; the API's ~0.5 GiB
  holds request bodies (20 MB at most per upload) and the operator console's inline
  PDF rebuild, which renders in the API's own Chromium.
- **PostgreSQL and Redis are the last things the kernel may kill, and have no
  ceiling.** A cgroup limit on PostgreSQL would only move the kill inside its
  container, with the same connection reset. Both get `oom_score_adj: -900`, which
  every backend and Redis's rewrite child inherit, and both are bounded by their own
  settings. PostgreSQL runs the image defaults (`shared_buffers` 128 MB, autovacuum
  at `maintenance_work_mem` 64 MB a worker), and the API and worker pools open at
  most ten connections each.
- **Redis's ceiling refuses writes; it never evicts.** BullMQ requires
  `maxmemory-policy noeviction`, because an evicted key is a lost or corrupted job.
  At `maxmemory` Redis answers writes with `OOM command not allowed when used memory
  > 'maxmemory'`, which shows in the API and worker logs and stops jobs from being
  queued or finished. Generation state lives in PostgreSQL, so nothing is lost, and
  the failure is loud and attributable instead of memory quietly taken from the host
  by a process the kernel will not kill. Finished BullMQ jobs are trimmed by the
  application (`GENERATION_JOB_RETENTION` in `packages/core/src/jobLanes.ts`):
  completed jobs for a day and at most 1,000 per lane, failed ones for a week and at
  most 2,000 per lane, both on each job's own options and on the Workers, so jobs an
  older release queued are trimmed too. Trimming runs when another job finishes, so
  a quiet queue keeps its last jobs past their age. The deploy prints
  `used_memory_human` against `maxmemory_human` after every release; if they still
  meet, lower those counts before raising the ceiling.
- **OOM order if the whole host still runs out:** the worker (+500: a killed job is
  picked up again; a killed PostgreSQL backend resets every connection), then the
  API, then the small processes, and PostgreSQL and Redis last.
- **Both job lanes run inside the worker container and share its 2 GiB** (see
  [Job lanes](#job-lanes)). A second worker *container* is a new row in this table
  and a new sum, not a copy of the worker service.

**Swap.** `aws_ssm_association.swap` (`swap.tf`) runs
`scripts/prepare-production-swap.sh` after the root filesystem is grown: a 2 GiB
`/swapfile`, written out in full (a preallocated file can be refused by `swapon` on
XFS), listed in `/etc/fstab`, and `vm.swappiness = 10` in
`/etc/sysctl.d/90-book-maker-swap.conf`, so the kernel drops page cache long before it
swaps. It is a cushion against a burst, not working memory. Rerunning it, which a
script change or a new instance does, never switches off or rewrites an active
swapfile: `swapoff` on a busy host forces every swapped page back into memory at
once. To change the size, run `swapoff /swapfile` while the host has free memory,
delete it, and rerun the script. It refuses to create the file when that would leave
less than the deploy's 4 GiB pull floor free, and asks for a larger
`ROOT_VOLUME_SIZE` instead.

The swapfile is on the root filesystem, so the deploy's disk floors are measured
after it. On the 30 GiB volume: about 3 GiB OS, 2 GiB swap, about 5–6 GiB for the
current and previous releases' images plus the database and edge images, the 4 GiB
the pull needs, and the rest (about 15 GiB) for PostgreSQL, Redis and logs to grow
into.

**Measuring it.** On the host (see [Operations](#operations)):

```bash
docker stats --no-stream
free -h; swapon --show
docker compose --env-file .env -f docker-compose.production.yml exec worker cat /sys/fs/cgroup/memory.peak
journalctl -k | grep -i -e 'out of memory' -e 'oom-kill'
docker inspect --format '{{.Name}} OOMKilled={{.State.OOMKilled}}' $(docker ps -aq)
```

`memory.peak` is the container's high-water mark since it started; read it right
after a large illustrated compile.

### Job lanes

The worker consumes two BullMQ queues with one `Worker` each, in one process
(`packages/core/src/jobLanes.ts`, `apps/worker/src/runtime/laneWorkers.ts`):

- **`book-maker`, the long lane** — a book run (composed books are one 9–93 minute
  job), its pages and pictures, the compile that ends a generation, narration and
  imports. It keeps the original queue's name, so jobs an older release left in
  Redis are still consumed after a deploy. Work that continues a book already
  started runs before any new book starts, so a waiting book's place in line is
  real; the app shows it as "Waiting in line — N books ahead of yours".
- **`book-maker-interactive`** — plans, chat edits, Writing Studio assists,
  portraits, character personas, and compiles of a book that already exists (edit
  recompiles, reprints, export repairs, Studio publishes). A chat edit that rewrites
  more than 40 pages (`LONG_LANE_EDIT_PAGE_THRESHOLD`) is a book's worth of model
  calls and waits in the long lane instead, as a start.

| Setting | Production | Unset |
| --- | --- | --- |
| `WORKER_LONG_CONCURRENCY` | 1 | `max(MAX_PARALLEL_PAGE_JOBS, MAX_PARALLEL_IMAGE_JOBS)`, the single queue's old concurrency |
| `WORKER_INTERACTIVE_CONCURRENCY` | 2 | 2 |

One long job and two interactive ones fit the 2 GiB because what they share is
bounded separately: Chromium never runs more than two renderers whatever the lane
count (`RENDER_CONCURRENCY` in `browserPool.ts`), and interactive jobs are a planner
call, a handful of pages or one picture, tens of MiB of heap against the long job's
manuscript. A second long job would double the largest working set and the
provider spend running at once; measure a large illustrated compile with the
**Measuring it** steps above before raising it. `MAX_PARALLEL_PAGE_JOBS` and
`MAX_PARALLEL_IMAGE_JOBS` still size a book's page and picture waves; with the long
lane at 1 those waves queue rather than run together, as they did before the lanes.

One account holds at most one book's long work at a time on the free tier and three
on a plan (`apps/api/src/mobile/booksInProgress.ts`, 429 `BOOKS_IN_PROGRESS_LIMIT`).

The worker's compose healthcheck (`scripts/worker-healthcheck.sh`) passes only while
both lanes' heartbeat keys exist and were last written by that container, so a new
worker is not reported healthy on the beat its drained predecessor left behind. It
is bash over `/dev/tcp`, about 10 ms of CPU a run, where the Node check it replaced
cost about 0.55 s every 15 s. **Rolling back to a release
older than the lanes:** that release's worker consumes only `book-maker`, so jobs
still waiting in `book-maker-interactive` would sit until its lost-delivery sweep
fails and refunds them two hours later. Roll back only once that queue is empty —
`LLEN bull:book-maker-interactive:wait` and `LLEN bull:book-maker-interactive:active`
both 0 in `docker compose exec redis redis-cli` — or redeploy this release.

## Changing the instance type

`instance_type` is an in-place update. Terraform stops the instance, changes its type
and starts it again: same instance ID, same root volume (the swapfile and its fstab
line come back with it), same private address, and the Elastic IP stays associated,
so DNS does not change. The instance has no `user_data`, so nothing reruns on boot,
and neither SSM association is replaced by a type change. The auto-assigned public
address changes, but nothing uses it.

What it costs is downtime. The whole site is down from the stop until Docker has
restarted the containers (`restart: unless-stopped`) and the API has booted: expect
three to five minutes. On shutdown systemd gives Docker its default 90 seconds to
stop every container, so a job that needed the worker's five-minute drain is cut off
and picked up again after the restart. The deploy job that follows in the same
workflow run then has its own usual short outage. The first apply of the move from
t3.small does all of this together with the 20 → 30 GiB volume growth and the new
swap association, and the deploy after it recreates PostgreSQL and Redis once with
their new memory settings, after the worker has drained. Merge it outside peak hours
and when no book is generating:

```bash
docker compose --env-file .env -f docker-compose.production.yml exec -T postgres \
  psql -U bookmaker -d bookmaker -c "SELECT type, count(*) FROM \"GenerationJob\" WHERE status = 'ACTIVE' GROUP BY type"
```

A t3.medium is about $17.50 a month more than a t3.small in eu-central-1 (on-demand,
$0.048 against $0.024 an hour).

Going back to a smaller type is a change to this budget too: on a t3.small the
ceilings alone add up to 3 GiB.

## Releasing an app update

The API and the app ship separately, and installed apps update whenever their owners let Play do
it, so the API has to keep answering every build still in use.

1. Bump `version:` in `apps/mobile/pubspec.yaml`. The `+N` is the build number (`versionCode`):
   Play requires it to grow, and it is the number the server compares.
2. `make mobile-build-release GOOGLE_SIGN_IN_CLIENT_ID=<web-client-id>.apps.googleusercontent.com`,
   upload `apps/mobile/build/app/outputs/bundle/release/app-release.aab`, roll out. The build
   refuses to run without the upload key in `apps/mobile/android/key.properties` or without the
   client ID; creating the key and enrolling in Play App Signing are in
   `apps/mobile/CLAUDE.md`, "Release signing".
3. Once Play Console shows 100% rollout, wait about a day, then open `/admin/app-updates`, add
   the release, and choose what it asks of older builds:
   - **Silent**: nothing shown. Play's auto-update handles it.
   - **Ask**: a dismissible "update available" on the home screen, once per release.
   - **Require**: the app shows only "Update Tomeza to keep going", and the API answers 426 to
     every mobile request from those builds.

   A policy covers every build below its release. Changing one later is a new save, and apps
   see it within about 30 seconds.
4. Remove compatibility code for old builds only after you require an update past them.

## Spend controls

The AI spend breaker is at `/admin/spend` (operator console, **AI spend** tab). It shows today's
provider spend (UTC day, the sum of priced provider calls) split into free readers, paid readers
and calls that name no reader, the month's free spend against its ceiling, the state each puts free
and paying readers in, and today's top ten spenders with their plan. Every save is an audit
revision; the API process that took it acts at once, any other within a minute.

The budget caps count **free spend** — readers with no plan at any moment of the window, plus calls
that name no reader — and stop only free accounts, so an account farm or a viral day cannot pause
AI for paying readers. Paid spend is backed by subscriptions; operator-console books count as paid.

- **Pause** refuses every new AI action in the app for everyone (503 `AI_PAUSED`, "your credits
  and books are safe — please try again later"). Free actions (reading, exports, moving pictures,
  undo) keep working.
- **Soft cap** (default $5/day of free spend, the monthly ceiling's pace): free accounts cannot
  start Ultra books, voice calls or audiobooks (503 `AI_BUSY`), and new accounts' welcome credits
  wait until the day resets or the cap is raised. Paid plans are unaffected.
- **Hard cap** (default $12/day of free spend): free accounts start no new AI work until 00:00 UTC
  (503 `AI_PAUSED`, saying paid plans are not affected). Paid plans are unaffected.
- **Monthly ceiling** (default $150 of free spend per UTC month — the AI share of a $200 month with
  no ads; lower it to ~$100 in a month the full ad budget runs): past it, free accounts are held as
  past the hard cap until the 1st or until you raise it, and welcome credits wait.
- **Paid cap** (default $60/day of paid spend, two paying readers at their own cap): a catastrophe
  stop for stolen accounts, a stuck client or an under-charging price. Past it, paying readers start
  no new AI work until 00:00 UTC (503 `AI_PAUSED`). Free accounts follow their own caps.
- **Per-reader caps** (defaults $1.50/day free, $30/day on any paid plan): a reader past theirs gets
  429 `AI_DAILY_LIMIT` until 00:00 UTC. A credit-pack buyer with no plan counts as free. The
  console's own `local-admin` user has no cap and is never a free account.

None of these stops the worker: books, edits and narrations already queued were paid for and finish,
and a voice call already connected runs to its end. The spend is a floor (unpriced calls count
nothing), so set hard budget caps in every provider console with a key configured (Gemini / Google Cloud
billing, OpenAI, DeepSeek, DeepInfra, OpenRouter, Alibaba, Vercel AI Gateway) as the backstop; the
breaker cannot see a provider's bill.
If the database cannot be read, the breaker lets work through rather than taking the app down, but
a pause it has already seen keeps holding. Each API process logs `ai_spend.soft_cap_reached`,
`ai_spend.hard_cap_reached` and `ai_spend.paid_cap_reached` once per UTC day and
`ai_spend.monthly_cap_reached` once per month when it first sees a cap crossed, and the alert sweep
emails each cap at most once per UTC day (see [Monitoring and alerts](#monitoring-and-alerts)).

## Monitoring and alerts

Three layers, from the outside in. Each sees something the other two cannot.

| Layer | Watches | Reaches you through | Set up |
| --- | --- | --- | --- |
| An external uptime monitor | `https://tomeza.ravanix.app/api/ready` from the internet: DNS, TLS, Caddy, Nginx, the API and everything readiness checks, outgoing mail included | the monitor's own email or app | a free account ([below](#point-an-uptime-monitor-at-apiready)) |
| The API's alert sweep | the application: PostgreSQL, Redis, S3, outgoing mail, both worker lanes, queue backlog, failed jobs, disk, AI spend, open child-safety reports | email to `OPERATOR_ALERT_EMAIL`, through `SMTP_URL` | `PRODUCTION_ENV`, then [send a test alert](#send-a-test-alert-after-every-deploy) |
| CloudWatch alarms (`monitoring.tf`) | the instance: an AWS host fault, a hung OS, CPU credits | SNS email to the `ALERT_EMAIL` repository variable | the variable, then confirm the subscription |

The sweep runs inside the API, so when the API or the whole host is down it is silent — and when
mail itself is broken its emails cannot leave. That is what the other two are for: set up all three.

### `/api/health` and `/api/ready`

- **`/api/health` is liveness and touches nothing.** It answers from the Node process alone. The
  compose healthcheck and the deploy's final `curl` poll it, and that health gates the deploy's
  `up --wait` and the web container's start, so it must not fail over a long queue, a worker that
  has not written its first heartbeat yet, or PostgreSQL blinking.
- **`/api/ready` is readiness, and it is what a monitor watches.** Public (no cookie, exempt in
  `apps/api/src/auth.ts` like `/api/health`), 200 when every check passes and 503 otherwise, with
  a body that says only which checks pass:
  `{"ok":false,"checks":{"db":"ok","redis":"ok","storage":"ok","mail":"ok","worker_long":"fail",…}}`. No
  hostnames, errors or numbers. One probe is cached for 10 seconds and shared by every caller, so
  polling it, or anyone hammering it, costs at most one round of checks per 10 seconds.

| Check | Fails when |
| --- | --- |
| `db` | `SELECT 1` does not answer within 3 s |
| `redis` | Redis is not connected, or `PING` takes over 3 s |
| `storage` | an S3 `HeadBucket` on the assets bucket fails or takes over 3 s |
| `mail` | the last SMTP check failed: the API connects and logs in to `SMTP_URL` (sending nothing) right after it starts and every 10 minutes, and caches the answer, so this check opens no connection itself. A test alert that fails counts too, and so does a reader's password-reset or verification code that cannot be sent (a refused *recipient* address does not count — that address came from a reader). A wrong password, host or port shows up here within 10 minutes of a deploy, while password-reset codes and every alert email are failing; the reason is in the API log as `email.verify_failed` |
| `worker_long`, `worker_interactive` | that lane's heartbeat key has expired. The worker writes one per lane every 30 s with a 90 s TTL, from a timer on its own event loop, so a dead, crash-looping or wedged worker all stop beating. BullMQ's consumer list (what the compose healthcheck asked until 2026-10) cannot see a wedged one |
| `queue_long`, `queue_interactive` | the oldest waiting (`QUEUED`) job in that lane has waited over **3 hours** (long) or **15 minutes** (interactive). A composed book is one job of up to ~93 minutes on a one-job lane, so 3 hours is about two maximum-length books ahead; interactive work takes seconds to minutes on two slots with a reader watching |

Right after a deploy `/api/ready` can answer 503 for a minute while the new worker writes its first
heartbeat, so let a monitor confirm a failure before it alerts.

### Point an uptime monitor at `/api/ready`

Any free HTTP monitor will do — UptimeRobot (5-minute checks) or Better Stack (3-minute) on their
free plans, for example. Create an HTTPS monitor for `https://tomeza.ravanix.app/api/ready` that
expects status 200, alerts after two or three consecutive failures, and emails you (and pushes to
the monitor's phone app, if it has one). If it offers a certificate-expiry check, turn it on.

This is the only layer that sees what the instance cannot see about itself: the Hetzner DNS record,
the certificate, the Elastic IP, and the API or the whole host being down. A Route 53 health check
could do it from AWS, but its metrics exist only in us-east-1, which needs a second provider, a
second SNS topic and a second subscription to confirm, and it is billed per check; the free monitor
does the same job.

### The operator alert emails

Every minute the API observes each condition below. A condition fires only after failing on
consecutive sweeps and clears only after passing on consecutive sweeps, so a deploy's restart or one
slow query sends nothing. You get **one email when it fires and one when it clears**; conditions
that move together arrive in one email; and a condition that clears and fails again within the hour
is held rather than re-sent (if it is still failing when the hour is up, you hear about it then).
The state lives in the `OperatorAlert` table, so a restart neither repeats an alert nor forgets the
recovery it owes, and the `sweep` row there makes one API process the sender. If the database itself
is down the sweep still alerts from memory and writes its state back when the table returns. Without
`OPERATOR_ALERT_EMAIL` the same transitions are logged as `operator_alert.firing` and
`operator_alert.recovered`; a failed send is logged as `operator_alert.email_failed` and is not
retried.

The compose prefix below is `docker compose --env-file .env -f docker-compose.production.yml`, run
in `/opt/book-maker/current` as in [Operations](#operations).

| Alert | Fires when | First thing to check |
| --- | --- | --- |
| Outgoing mail (SMTP) | `mail` fails 3 minutes running. **This one cannot reach you while it fires** — the email it sends fails too (`operator_alert.email_failed`). The uptime monitor on `/api/ready` is what tells you; the recovery email arrives once mail works and says how long it was down, which is the window in which other alerts and readers' reset codes were lost | `… logs --tail 100 api \| grep email.verify_failed` for the server's answer; the host, port, user and password in `SMTP_URL`; the mail provider's dashboard (a suspended account, a sending limit). After fixing, [send a test alert](#send-a-test-alert-after-every-deploy) |
| Database (PostgreSQL) | `db` fails 3 minutes running | `… ps postgres`, `… logs --tail 100 postgres`, `df -h /` (a full disk stops PostgreSQL) |
| Redis (the job queue) | `redis` fails 3 minutes running | `… logs --tail 100 redis`; `… exec redis redis-cli info memory` — at `maxmemory` Redis refuses every write ([Memory budget](#memory-budget-and-swap)) |
| Object storage (S3) | `storage` fails 3 minutes running | the bucket error in `… logs --tail 100 api`; the instance role, the bucket and `S3_REGION`; AWS's health dashboard |
| Worker, long lane / interactive lane | that lane's heartbeat missing 3 minutes running (so about 4–5 minutes after the worker stopped) | `… ps worker` (restarting? exit code?), `… logs --tail 200 worker`, `docker inspect --format '{{.State.OOMKilled}}' book-maker-worker-1`, `journalctl -k \| grep -i oom`. Both lanes at once is the process; one lane alone is that lane's BullMQ worker, whose error is in the log |
| Long / interactive lane backlog | that lane's `queue_*` check fails 3 minutes running | the running jobs: `… exec -T postgres psql -U bookmaker -d bookmaker -c "SELECT id, type, \"startedAt\", message FROM \"GenerationJob\" WHERE status = 'ACTIVE' ORDER BY \"startedAt\""`. One running for hours is hung: restart the worker (its job is redelivered). Several legitimate long books is capacity — see [Job lanes](#job-lanes) before raising concurrency |
| Free-account AI spend past the soft / hard daily cap | the [spend breaker](#spend-controls)'s free spend (free readers plus unattributed calls) reaches a cap; at most once per cap per UTC day | `/admin/spend`: today's top spenders (several new free accounts is a farm), then raise the cap or pause. Clears at 00:00 UTC or when the cap is raised |
| Free-account AI spend past the monthly ceiling | the month's free spend reaches the ceiling; free accounts start no new AI work | `/admin/spend`: the month against the budget, then raise the ceiling or leave it until the 1st. Clears on the 1st or when it is raised |
| Paid-plan AI spend past the paid daily cap | paying readers' spend today reaches the paid cap; paying readers start no new AI work | `/admin/spend`: today's top spenders (a stolen account or a stuck client), every provider's billing page, then raise the cap. Clears at 00:00 UTC or when it is raised |
| Generation jobs failing | 5 or more jobs `FAILED` in the last hour, a reader's own Stop excluded | `SELECT type, error, "finishedAt" FROM "GenerationJob" WHERE status = 'FAILED' ORDER BY "finishedAt" DESC LIMIT 20`, then that book's run log ([storage.md](storage.md)); a provider key, its credit balance or its status page |
| Low free disk on the host | under 15% free (or 10% of inodes) two minutes running; clears at 17% | `df -h /`, `docker system df`, then [Image retention and the disk guard](#image-retention-and-the-disk-guard). 15% of 30 GiB is just above the 4 GiB a deploy needs to pull, so this arrives before a deploy is refused |
| Open child-safety or sexual-content reports | on the **first** sweep that finds a `PENDING` report a reader filed as child safety or sexual content — from a share's public page, a book, a picture, a voice call, a chat reply or any AI output — or a live share the sexual-content screen held because it could not decide part of the book's text (`book_text_review`). The email says how many of each are open and when the oldest arrived. More reports while it fires are the same alert, not more email; it clears on the first sweep with none open, and an hour must pass before it can fire again | `/admin/moderation`, child safety first: take the share down, or suspend the account (or turn its sharing off) from `/admin/users`, then Action or Dismiss the report. "Mark reviewed" also counts as an answer. A held book text is closed by *Approve book text* (or *Approve caption*) or a take-down |

The disk is read from the API container's own `/`: Docker builds it as an overlay filesystem, and an
overlay reports the free space of the disk under it — the one holding Docker, PostgreSQL and Redis.

To rehearse it outside peak hours: `… stop worker`, wait about five minutes for the worker emails,
then `… start worker` and wait for the recovery.

### Send a test alert after every deploy

`POST /api/admin/monitoring/test-alert` sends one email, "[Tomeza] Test alert", to
`OPERATOR_ALERT_EMAIL` through the same transport the alerts use, and answers with what happened:
200 `{"ok":true,"sentTo":…}`, 502 with the mail server's refusal, 409 when `OPERATOR_ALERT_EMAIL` is
unset, 503 when `SMTP_URL` is. It is an operator route (the console cookie, like everything under
`/api/admin`). The quickest way: sign in to the console at `https://tomeza.ravanix.app`, open
Operations and press **Send test alert** in the header, which shows the answer beside it. Without the
console, open the browser's developer console on a signed-in tab and run

```js
await (await fetch("/api/admin/monitoring/test-alert", { method: "POST" })).json()
```

or from a shell, with the console password:

```sh
curl -s -c /tmp/tomeza-op -H 'content-type: application/json' \
  -d '{"password":"<WEB_PASSWORD>"}' https://tomeza.ravanix.app/api/auth/login
curl -s -b /tmp/tomeza-op -X POST https://tomeza.ravanix.app/api/admin/monitoring/test-alert; rm /tmp/tomeza-op
```

A failed send also fails the `mail` readiness check until the next successful SMTP check, so a
broken transport found this way is on the uptime monitor too.

### CloudWatch alarms

`monitoring.tf` creates the SNS topic `book-maker-alerts` and three alarms. Each emails when it goes
into alarm and again when it returns to OK.

| Alarm | Means | Does | Then |
| --- | --- | --- | --- |
| `book-maker-status-check-system` | AWS's side of the instance failed (host hardware, power, network) for 2 minutes | **recovers** the instance onto healthy hardware: same instance ID, Elastic IP and root volume, memory lost, a reboot | the alarm's SNS email reports the recovery. If it fails, stop and start the instance from the EC2 console, which also moves it to new hardware |
| `book-maker-status-check-instance` | the OS stopped answering EC2 for 3 minutes (kernel panic, memory exhausted with swap thrashing, a disk so full SSM cannot write) | **reboots** it; Docker restarts every service | `journalctl -k -b -1 \| grep -i -e oom -e panic`, `df -h /`, then [Memory budget and swap](#memory-budget-and-swap) |
| `book-maker-cpu-credits-low` | the t3.medium has under 50 CPU credits for 15 minutes. It runs in T3's unlimited mode, so past zero every minute above 20% CPU is billed as surplus, about $0.05 per vCPU-hour (~$58 a month flat out) | email only | `docker stats --no-stream`, `top`; a runaway process, a stuck Chromium, or real load. A freshly launched instance trips it once while it banks credits |

**Turning it on:** add the repository variable `ALERT_EMAIL` (Settings → Secrets and variables →
Actions → Variables) and run the Terraform workflow. AWS then emails that address "AWS Notification -
Subscription Confirmation"; **click Confirm subscription within three days**, or nothing is ever
delivered. Check it with `aws sns list-subscriptions-by-topic --topic-arn "$(terraform output -raw
alerts_topic_arn)"`: the subscription ARN must be a real ARN, not `PendingConfirmation`. Terraform
cannot confirm a subscription or delete an unconfirmed one; an unconfirmed one expires on its own.
To test delivery, force the CPU alarm, which has no EC2 action — never the two status-check alarms,
which would really reboot or recover the instance:
`aws cloudwatch set-alarm-state --alarm-name book-maker-cpu-credits-low --state-value ALARM --state-reason test`.
It returns to OK at its next evaluation.

All three are standard alarms on free basic-monitoring metrics, inside CloudWatch's ten free alarms,
and SNS email is free up to 1,000 messages a month.

### What is not covered

- **No log shipping.** Logs stay in Docker's local `json-file` driver (10 MB × 3 files per
  container), so reading them takes an SSM session, they rotate away within days on a busy worker,
  and they are lost with the instance. CloudWatch Logs through Docker's `awslogs` driver would keep
  them searchable: roughly $0.60 per GB ingested and $0.03 per GB-month stored in eu-central-1 after
  the free 5 GB (check the pricing page), so about $1–2 a month at launch volume with 30-day
  retention, plus `logs:CreateLogStream` and `logs:PutLogEvents` on the instance role and a log group
  in Terraform. Not built.
- **No error tracking.** An unhandled exception is a log line; nothing groups or counts them. Sentry's
  free tier would cover launch volume. Not built.
- **No metrics or dashboards.** No request latency, error rates or memory trends beyond `docker stats`
  and `memory.peak` ([Measuring it](#memory-budget-and-swap)).
- **Not watched:** Google Play purchase and refund-notice failures, push delivery, a provider failing
  for only some books (below the five-failures-an-hour line), the daily snapshots in `backups.tf`, and
  the certificate's expiry unless the uptime monitor checks it. The per-deploy database dump is checked
  by the deploy itself: a failed one fails the release before anything is migrated.

## Operations

Use an SSM session, then:

```bash
sudo -i
cd /opt/book-maker/current
set -a
. ./images.env
set +a
docker compose --env-file .env -f docker-compose.production.yml ps
docker compose --env-file .env -f docker-compose.production.yml logs --tail 100 api worker web caddy
curl --fail http://127.0.0.1/api/health   # through Caddy and Nginx
curl -s http://127.0.0.1/api/ready        # which readiness check is failing, if any
```

`images.env` contains image digests and the non-secret S3 bucket/region. Do not source the application `.env` as
a shell script. If deployment fails before a `current` link exists, use the release
directory printed in the SSM command. The GitHub job prints the SSM command ID and
the final command output for diagnosis.

### Full root filesystem / SSM worker timeout

Increasing `ROOT_VOLUME_SIZE` changes the EBS block device, but an existing Linux
partition and filesystem can remain at the AMI's original size. This caused the
September 18 deployment failure: a 20 GiB EBS volume still had a 6.7 GiB root
filesystem, Docker ran out of space extracting an image, and SSM reported an IPC
worker timeout because it could no longer write its own state.

Terraform's `aws_ssm_association.root_filesystem` runs
`scripts/prepare-production-disk.sh` and waits up to ten minutes for success.
It detects the mounted root device, grows its partition with `growpart`, expands
ext4 or XFS online, and requires at least 2 GiB free before continuing. It uses
`/run` for growpart's temporary files so a full `/tmp` does not prevent recovery.
Repeated runs are safe, including when only the partition was previously grown.
Unsupported layouts such as LVM fail with an explicit message.

The association is replaced when the instance, configured volume size, or script
changes. Only the association is replaced; this repair does not replace EC2 or
its volume. Creation is intentional: AWS provider v5 waits for successful
creation but does not wait for execution after an in-place association update.
The 2 GiB check is minimum headroom, not a guarantee that every future image fits.
The swap association (`swap.tf`) depends on this one, so the swapfile's 2 GiB is
taken from the grown filesystem; see [Memory budget and swap](#memory-budget-and-swap).

**Growing the volume.** Raising `ROOT_VOLUME_SIZE`, or the 20 → 30 GiB default
change, modifies the EBS volume in place. The partition and filesystem keep their old
size until `growpart` and `resize2fs` or `xfs_growfs` run. Terraform does that: the
volume size is one of the association's replacement triggers, so the same apply
reruns `prepare-production-disk.sh`. If you resize outside Terraform, run the script
yourself through SSM (`sudo bash prepare-production-disk.sh`). AWS allows one
modification per volume every six hours. If a repository variable
`ROOT_VOLUME_SIZE` is set, it overrides the 30 GiB default (the workflow falls back
to 30 only when it is unset).

Compare `lsblk` with `df -h /` when investigating disk errors. If EBS space is
unallocated, apply Terraform to run the preparation. If the filesystem already
uses the volume, increase `ROOT_VOLUME_SIZE` and apply Terraform. Never delete
Docker volumes to recover deployment space. If SSM cannot start any command,
the association cannot repair the host; inspect EC2 console output and arrange
host recovery before retrying. See AWS's
[filesystem expansion procedure](https://docs.aws.amazon.com/ebs/latest/userguide/recognize-expanded-volume-linux.html).

To check images locally using disposable containers and volumes:

```bash
docker build --target app -t book-maker:app .
docker build --target web -t book-maker:web .
APP_IMAGE=book-maker:app WEB_IMAGE=book-maker:web bash scripts/check-production-docker.sh
```

The smoke test binds an ephemeral localhost port directly on Nginx, validates the
Caddyfile with `caddy validate` without starting Caddy (so it never contacts
Let's Encrypt), and removes only its own test volumes. `docker-compose.yml`
remains the development stack and has no Caddy service.

References: [SSM Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html),
[AMIs with SSM Agent](https://docs.aws.amazon.com/systems-manager/latest/userguide/ami-preinstalled-agent.html),
and [Compose service readiness](https://docs.docker.com/compose/how-tos/startup-order/).
