#!/bin/sh
# H3 eval driver: runs inside the worker container, one process per (book, arm, draw), sequentially.
cd /app/apps/worker
run() { # plan arm draw [--expansion]
  echo "$(date +%T) start $1 $2 d$3" >> /app/.scratch/eval-data/results/h3/driver.log
  timeout 1500 pnpm exec tsx /app/scripts/eval/container/h3-material.ts --plan "$1" --arm "$2" --draw "$3" $4 \
    > /app/.scratch/eval-data/results/h3/$1__$2__d$3.stdout 2> /app/.scratch/eval-data/results/h3/$1__$2__d$3.stderr
  echo "$(date +%T) done $1 $2 d$3 exit $?" >> /app/.scratch/eval-data/results/h3/driver.log
}
B1=cmv9llqo4001i1mqgjtp295p1; B2=cmv9lngxm001z1mqg6eq537oa; B3=cmuonmrj9000050g0a6wsp1p3; B4=cmuocfllk0018r3pdsgx9z2k5
run $B1 today 1 --expansion; run $B1 merged 1 --expansion; run $B1 today 2
run $B2 merged 1 --expansion; run $B2 today 1 --expansion; run $B2 today 2
run $B3 today 1 --expansion; run $B3 merged 1 --expansion; run $B3 today 2
run $B4 merged 1 --expansion; run $B4 today 1 --expansion; run $B4 today 2
echo "$(date +%T) ALL DONE" >> /app/.scratch/eval-data/results/h3/driver.log
