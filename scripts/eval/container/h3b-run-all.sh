#!/bin/sh
# H3b eval driver (2026-10-16): the `leads` arm of container/h3-material.ts on H3's four books, one process per book.
cd /app/apps/worker
LOG=/app/.scratch/eval-data/results/h3/driver-h3b.log
for B in cmv9llqo4001i1mqgjtp295p1 cmv9lngxm001z1mqg6eq537oa cmuonmrj9000050g0a6wsp1p3 cmuocfllk0018r3pdsgx9z2k5; do
  echo "$(date +%T) start $B leads d1" >> $LOG
  timeout 1500 pnpm exec tsx /app/scripts/eval/container/h3-material.ts --plan "$B" --arm leads --draw 1 --expansion \
    > /app/.scratch/eval-data/results/h3/${B}__leads__d1.stdout 2> /app/.scratch/eval-data/results/h3/${B}__leads__d1.stderr
  echo "$(date +%T) done $B leads d1 exit $?" >> $LOG
done
echo "$(date +%T) ALL DONE" >> $LOG
