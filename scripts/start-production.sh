#!/bin/sh
set -eu

shutdown() {
  if [ "${api_pid:-}" ]; then
    kill "$api_pid" 2>/dev/null || true
  fi
  if [ "${worker_pid:-}" ]; then
    kill "$worker_pid" 2>/dev/null || true
  fi
}

trap shutdown INT TERM

pnpm db:deploy
pnpm db:seed

pnpm --filter @book-maker/worker start &
worker_pid=$!

pnpm --filter @book-maker/api start &
api_pid=$!

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$worker_pid" 2>/dev/null; do
  sleep 1
done

if kill -0 "$api_pid" 2>/dev/null; then
  wait "$worker_pid" || status=$?
else
  wait "$api_pid" || status=$?
fi

shutdown
wait "$api_pid" 2>/dev/null || true
wait "$worker_pid" 2>/dev/null || true

exit "${status:-0}"
