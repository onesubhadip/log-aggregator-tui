#!/usr/bin/env bash
set -euo pipefail

DIR="${1:-.}"
COUNT="${2:-200}"
DELAY_MS="${3:-150}"

mkdir -p "$DIR"

files=("log1.log" "log2.log" "log3.log" "api-json.log")
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
methods=("GET" "POST" "PUT" "PATCH" "DELETE")
paths=("/api/v1/users" "/api/v1/orders" "/api/v1/cart" "/api/v1/login" "/api/v1/health")
statuses=(200 201 202 204 400 401 403 404 409 429 500 502)

delay_sec="$(awk "BEGIN {print $DELAY_MS/1000}")"

timestamp() {
  local base ms
  base="$(date -u +"%Y-%m-%dT%H:%M:%S")"
  ms="$(printf "%03d" "$((RANDOM % 1000))")"
  printf "%s.%sZ" "$base" "$ms"
}

random_ip() {
  printf "10.0.%d.%d" "$((RANDOM % 255))" "$((RANDOM % 255))"
}

json_line() {
  local type="$1"
  local request_id="$2"
  local method="$3"
  local path="$4"
  local status="$5"
  local duration_ms="$6"
  local bytes="$7"
  local ts
  ts="$(timestamp)"

  if [ "$type" = "request" ]; then
    printf '{"timestamp":"%s","type":"request","request_id":"%s","method":"%s","path":"%s","remote_ip":"%s"}' \
      "$ts" "$request_id" "$method" "$path" "$(random_ip)"
  else
    printf '{"timestamp":"%s","type":"response","request_id":"%s","status":%s,"duration_ms":%s,"bytes":%s}' \
      "$ts" "$request_id" "$status" "$duration_ms" "$bytes"
  fi
}

for _ in $(seq 1 "$COUNT"); do
  file="${files[$((RANDOM % ${#files[@]}))]}"
  service="${services[$((RANDOM % ${#services[@]}))]}"
  level="${levels[$((RANDOM % ${#levels[@]}))]}"
  message="${messages[$((RANDOM % ${#messages[@]}))]}"

  if [ "$file" = "api-json.log" ]; then
    request_id="$(printf "%08x" "$RANDOM")"
    method="${methods[$((RANDOM % ${#methods[@]}))]}"
    path="${paths[$((RANDOM % ${#paths[@]}))]}"
    status="${statuses[$((RANDOM % ${#statuses[@]}))]}"
    duration_ms="$((50 + (RANDOM % 900)))"
    bytes="$((128 + (RANDOM % 8192)))"

    json_line "request" "$request_id" "$method" "$path" "" "" "" >> "$DIR/$file"
    printf "\n" >> "$DIR/$file"
    json_line "response" "$request_id" "$method" "$path" "$status" "$duration_ms" "$bytes" >> "$DIR/$file"
    printf "\n" >> "$DIR/$file"
  else
    printf "%s [%s] %s %s\n" "$(timestamp)" "$service" "$level" "$message" >> "$DIR/$file"
  fi
  sleep "$delay_sec"
done
