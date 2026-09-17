# Docker deployment on AWS

Every push to `master` runs the Terraform workflow, applies infrastructure, then
calls `deploy.yml` to build and deploy the **same commit**. You can also run
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
   permissions plus permission to create/configure the S3 assets bucket, create ECR repositories, manage/pass the EC2
   IAM role, allocate/associate an Elastic IP (`ec2:AllocateAddress`,
   `ec2:AssociateAddress`, `ec2:DisassociateAddress`, `ec2:ReleaseAddress`,
   `ec2:DescribeAddresses`), push ECR images, write the `/book-maker/production/env` SSM parameter,
   and call `ssm:DescribeInstanceInformation`, `ssm:SendCommand` (the
   `AWS-RunShellScript` document and the EC2 instance), and
   `ssm:GetCommandInvocation`. Terraform's root-filesystem preparation also needs
   `ssm:CreateAssociation`, `ssm:DescribeAssociation`, `ssm:DeleteAssociation`,
   `ssm:ListTagsForResource`, `ssm:AddTagsToResource`, and `ssm:RemoveTagsFromResource`
   for its association and the `AWS-RunShellScript` document. ECR push uses `ecr:GetAuthorizationToken`,
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
   SSM. Terraform first expands the root partition/filesystem to use the existing
   EBS volume and waits for success before the build/deploy jobs can start. The
   AMI must include `growpart` and its filesystem tool (`resize2fs` for ext4,
   `xfs_growfs` for XFS). Deployment then installs Docker, Compose, and the AWS CLI
   if absent. The installer
   supports Ubuntu/Debian and Amazon Linux on x86_64.
4. Point DNS at the instance and set `PUBLIC_API_URL=https://tomeza.ravanix.app`.
   See [Public hostname and TLS](#public-hostname-and-tls) below for the exact
   Hetzner record, the secret to update, and the post-DNS check.

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

Terraform uses a **t3.small (2 GiB RAM)** and **20 GiB gp3 disk**. Resizing the
existing instance can stop/start it; the Elastic IP is unchanged. Worker concurrency
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
  Caddy keeps running and answers 502 meanwhile, so TLS and certificate renewal
  are unaffected; it is recreated once web is healthy, then the release is checked
  with `http://127.0.0.1/api/health` through the edge.
- A failed migration or unhealthy service fails the GitHub job. There is no
  automatic schema rollback. After fixing a failed release, rerun the workflow.
- Compose's named volumes retain PostgreSQL data, Redis AOF, and Caddy's
  certificates on the instance disk; snapshot/back up them before replacing or
  terminating the instance. Durable files survive independently in S3. The deploy
  script never deletes volumes or the assets bucket. S3 storage does not back up
  the database. Losing `caddy-data` only costs a fresh certificate request, within
  Let's Encrypt rate limits.
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
docker compose --env-file .env -f docker-compose.production.yml logs --tail 100 api worker web caddy
curl --fail http://127.0.0.1/api/health   # through Caddy and Nginx
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
