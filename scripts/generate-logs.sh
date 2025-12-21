#!/usr/bin/env bash
set -euo pipefail

DIR="${1:-.}"
COUNT="${2:-200}"
DELAY_MS="${3:-150}"

mkdir -p "$DIR"

files=("log1.log" "log2.log" "log3.log")
services=("api" "worker" "db" "auth" "cache")
levels=("INFO" "WARN" "ERROR" "DEBUG")
messages=(
  "boot sequence start"
  "listening on :8080"
  "GET /health 200 1ms"
  "POST /login 200 45ms user=alice"
  "job=sync-users start"
  "job=sync-users done rows=120"
  "cache miss key=session:42"
  "db query ok rows=3"
  "rate limit exceeded ip=10.0.0.5"
  "shutdown signal received"
)

delay_sec="$(awk "BEGIN {print $DELAY_MS/1000}")"

timestamp() {
  local base ms
  base="$(date -u +"%Y-%m-%dT%H:%M:%S")"
  ms="$(printf "%03d" "$((RANDOM % 1000))")"
  printf "%s.%sZ" "$base" "$ms"
}

for _ in $(seq 1 "$COUNT"); do
  file="${files[$((RANDOM % ${#files[@]}))]}"
  service="${services[$((RANDOM % ${#services[@]}))]}"
  level="${levels[$((RANDOM % ${#levels[@]}))]}"
  message="${messages[$((RANDOM % ${#messages[@]}))]}"

  printf "%s [%s] %s %s\n" "$(timestamp)" "$service" "$level" "$message" >> "$DIR/$file"
  sleep "$delay_sec"
done
