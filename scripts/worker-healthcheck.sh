#!/usr/bin/env bash
# The worker container's compose healthcheck (docker-compose.production.yml).
#
# Healthy while both lanes' heartbeat keys (packages/core/src/workerHeartbeat.ts)
# exist and were last written by *this* container. The worker writes each lane's
# key every 30 s with a 90 s TTL while that lane's BullMQ Worker runs, so this is
# "both lanes have a consumer" (what the check it replaced asked BullMQ) plus
# "its event loop is not wedged", which BullMQ's consumer list cannot see.
#
# The host comparison is what makes it a deploy gate. A key is the lane's, not
# the process's, and outlives a stopped worker by up to 90 s, while a deploy
# often starts the new worker sooner than that after the old one drained. Without
# it the new container would pass `up --wait` on the old one's beat. A recreated
# container has a new hostname; the worker records os.hostname() in each beat.
#
# Bash and /dev/tcp only: it runs every 15 s for the life of the container, and
# the Node + bullmq check before it cost about 0.55 s of CPU and 76 MB a run.
#
# Overrides, for scripts/test_worker_healthcheck.py: REDIS_URL (the worker's own,
# redis://redis:6379 in production) and HOSTNAME (Docker sets it).
set -u

fail() {
  echo "worker-healthcheck: $*" >&2
  exit 1
}

me=${HOSTNAME:-$(hostname)}
url=${REDIS_URL:-redis://redis:6379}
[[ $url == redis://* ]] || fail "REDIS_URL must be redis://host[:port]"
address=${url#redis://}
address=${address%%/*}
[[ -n $address && $address != *@* ]] || fail "REDIS_URL must be redis://host[:port] without credentials"
host=${address%%:*}
port=6379
[[ $address == *:* ]] && port=${address##*:}

# The two queues are LONG_JOB_QUEUE and INTERACTIVE_JOB_QUEUE in
# packages/core/src/jobLanes.ts; the test fails if they drift apart.
keys=(book-maker:worker-heartbeat:book-maker book-maker:worker-heartbeat:book-maker-interactive)

exec 3<>"/dev/tcp/$host/$port" || fail "cannot reach Redis at $host:$port"
for key in "${keys[@]}"; do
  printf '*2\r\n$3\r\nGET\r\n$%d\r\n%s\r\n' "${#key}" "$key" >&3
done
for key in "${keys[@]}"; do
  IFS= read -r -t 5 header <&3 || fail "no answer from Redis for $key"
  header=${header%$'\r'}
  # A bulk string is `$<length>`; `$-1` is a missing key, `-ERR …` an error.
  [[ $header =~ ^\$[0-9]+$ ]] || fail "$key has no heartbeat (${header})"
  IFS= read -r -t 5 beat <&3 || fail "truncated answer from Redis for $key"
  [[ ${beat%$'\r'} == *"\"host\":\"$me\""* ]] || fail "$key was last written by another worker, not $me"
done
exec 3>&-
