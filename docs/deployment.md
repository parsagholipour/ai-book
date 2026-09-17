# Docker deployment on AWS

Every push to `master` runs the Terraform workflow, applies infrastructure, then
calls `deploy.yml` to build and deploy the **same commit**. You can also run
**Actions → Terraform → Run workflow** on `master`. Pull requests only plan
infrastructure and never deploy. GitHub serializes the full apply/deploy workflow;
it does not cancel an active production deployment when another commit arrives.

The API and worker run in separate containers using the shared `app` Docker
target. The `web` target serves Vite's production build through Nginx on port 80
and proxies `/api`, `/docs`, and generated assets to the API. Browser requests use
the same origin, so no build-time API URL is needed. PostgreSQL/pgvector and Redis
run on the private Compose network. Only Nginx publishes a host port.
Durable files live in a private S3 bucket provisioned by Terraform. API and worker
containers have separate disposable scratch directories and share files through S3.

## One-time setup

1. Keep the existing repository secrets `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY`. The AWS principal must have the existing Terraform
   permissions plus permission to create/configure the S3 assets bucket, create ECR repositories, manage/pass the EC2
   IAM role, push ECR images, write the `/book-maker/production/env` SSM parameter,
   and call `ssm:DescribeInstanceInformation`, `ssm:SendCommand` (the
   `AWS-RunShellScript` document and the EC2 instance), and
   `ssm:GetCommandInvocation`. ECR push uses `ecr:GetAuthorizationToken`,
   `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`,
   `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, and `ecr:PutImage`.
2. Create the GitHub environment **production**. Add a secret **PRODUCTION_ENV**
   containing the contents of [`deploy/production.env.example`](../deploy/production.env.example)
   with real values. Provider settings from `.env.example` can be included. This
   is Compose `.env` syntax; single-quote values containing literal `$` characters.
   `POSTGRES_PASSWORD`, `WEB_PASSWORD`, and `PUBLIC_API_URL` are required. Use a
   URL-safe database password, e.g. `openssl rand -hex 32`. Do not change it after
   initialization without also rotating the PostgreSQL role password. Do not put
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
   SSM, then installs Docker, Compose, and the AWS CLI if absent. The installer
   supports Ubuntu/Debian and Amazon Linux on x86_64.
4. Choose a reachable origin for `PUBLIC_API_URL`. **The existing Terraform
   security group still permits HTTP/HTTPS only from the VPC subnet**. This change
   does not make the app public or configure DNS/TLS. For public use, put an HTTPS
   reverse proxy/load balancer in front and configure its ingress deliberately.
   For private testing, use SSM port forwarding to port 80 or a host in the subnet.

Terraform uses a **t3.small (2 GiB RAM)** and **20 GiB gp3 disk**. Resizing the
existing instance can stop/start it and change its public IP. Worker concurrency
defaults to one job because the database and Chromium share those 2 GiB. Large
PDF/image jobs can still exhaust that memory. The OCR model container is not
included on this 2 GiB host. Set `GEMINI_API_KEY` in `PRODUCTION_ENV` to read scanned
PDF pages and images using Google when no local OCR service is configured. If you
also set `SOURCE_OCR_URL` to a private PaddleOCR service, the worker tries it first
and falls back to Google when it fails. Pages handled by the fallback are sent to
Google and incur Gemini API usage. No extra OCR container is needed on EC2.
`GEMINI_OCR_MODEL` optionally overrides `GEMINI_TEXT_MODEL` for OCR. Set
`FULL_DOCUMENT_SOURCES=true` in `PRODUCTION_ENV` if enabling the full-document
source ingestion feature; it remains disabled by default.

The 20 GiB disk holds the OS, Docker images, PostgreSQL, Redis, and temporary
rendering files. The S3 bucket holds generated books, images, audio, voice,
attachments, and durable run artifacts. It blocks public access, requires TLS,
uses SSE-S3 encryption, and aborts unfinished multipart uploads after one day.
Terraform protects it from accidental destruction. There is no automatic expiry
for generated books and no versioning storage charge. Application retention rules
still remove expired uploads. See [storage and inspection](storage.md) for object
keys, local MinIO access, and AI contributor instructions.

This is a fresh storage cutover: existing local files are left untouched and are
not migrated or used as a fallback. If the earlier 40 GiB disk setting was already
applied, EBS cannot shrink it in place; retain that size for the existing instance
with GitHub repository variable `ROOT_VOLUME_SIZE=40` (locally,
`TF_VAR_root_volume_size=40`), or provision a fresh 20 GiB instance separately.
The workflow does not replace a server to shrink its disk.

## Release behavior

- GitHub builds on its runner, pushes uniquely tagged images to ECR, and deploys
  immutable image digests. No compilation takes place on the small EC2 instance.
- Before touching EC2, the workflow smoke-tests both images with mock providers,
  a fresh database, migrations, seed data, API/web/worker readiness, and private
  object storage through MinIO. It also recreates the app containers to check that
  objects survive without a shared filesystem.
- On EC2 the API and worker check that the assets bucket answers a `HeadBucket`
  through the instance role before they serve or take jobs. A missing bucket, a
  wrong region, a broken role, or stray MinIO settings in `PRODUCTION_ENV` leave
  those containers restarting, which fails the health wait and the release.
- Runtime secrets are written to SSM as a `SecureString` using the account's
  default SSM KMS key. Only non-secret scripts and image references enter the SSM
  command. The host retrieves the environment into a root-only `.env` file.
- A host lock prevents overlapping deployment commands. Images are pulled first;
  then the worker gets up to five minutes to drain. The API and web stop while
  migrations and idempotent seeding run, so deployments have a brief outage.
- A failed migration or unhealthy service fails the GitHub job. There is no
  automatic schema rollback. After fixing a failed release, rerun the workflow.
- Compose's named volumes retain PostgreSQL data and Redis AOF on the instance
  disk; snapshot/back up them before replacing or terminating the instance.
  Durable files survive independently in S3. The deploy script never deletes
  volumes or the assets bucket. S3 storage does not back up the database.
- Successful releases live under `/opt/book-maker/releases/`; `current` points to
  the last successful one. Unused local images older than seven days are pruned.
  ECR images are retained so an earlier image remains available for recovery.

## Operations

Use an SSM session, then:

```bash
sudo -i
cd /opt/book-maker/current
set -a
. ./images.env
set +a
docker compose --env-file .env -f docker-compose.production.yml ps
docker compose --env-file .env -f docker-compose.production.yml logs --tail 100 api worker web
```

`images.env` contains image digests and the non-secret S3 bucket/region. Do not source the application `.env` as
a shell script. If deployment fails before a `current` link exists, use the release
directory printed in the SSM command. The GitHub job prints the SSM command ID and
the final command output for diagnosis.

To check images locally using disposable containers and volumes:

```bash
docker build --target app -t book-maker:app .
docker build --target web -t book-maker:web .
APP_IMAGE=book-maker:app WEB_IMAGE=book-maker:web bash scripts/check-production-docker.sh
```

The smoke test binds an ephemeral localhost port and removes only its own test
volumes. `docker-compose.yml` remains the development stack.

References: [SSM Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html),
[AMIs with SSM Agent](https://docs.aws.amazon.com/systems-manager/latest/userguide/ami-preinstalled-agent.html),
and [Compose service readiness](https://docs.docker.com/compose/how-tos/startup-order/).
