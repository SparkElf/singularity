#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIRECTORY/../.." && pwd)"
COMPOSE_FILE="$REPOSITORY_ROOT/enterprise/docker-compose.test.yml"
SERVICE_NAME="singularity-postgres-test"
CONTAINER_NAME="singularity-postgres-test"
TEST_DATABASE_URL="postgresql://singularity_test:singularity_test@127.0.0.1:55432/singularity_test"

usage() {
  cat <<'EOF'
Usage: scripts/singularity/test-postgres.sh <up|wait|stop|status|url|env>

The database is persistent in the singularity-postgres-test-data Docker volume.
This command never removes the volume; reset it explicitly with Docker only when
the test database contents are intentionally being discarded.
EOF
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' "docker is required for the fixed PostgreSQL test service" >&2
    exit 127
  fi
}

compose() {
  docker compose --file "$COMPOSE_FILE" "$@"
}

wait_for_health() {
  local attempts=60
  local health=""
  while (( attempts > 0 )); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
    case "$health" in
      healthy)
        return 0
        ;;
      unhealthy)
        printf '%s\n' "PostgreSQL test service reported unhealthy" >&2
        return 1
        ;;
    esac
    attempts=$((attempts - 1))
    sleep 1
  done
  printf '%s\n' "Timed out waiting for PostgreSQL test service health" >&2
  compose logs --no-color "$SERVICE_NAME" >&2 || true
  return 1
}

command_name="${1:-status}"
case "$command_name" in
  up|start)
    require_docker
    compose up --detach "$SERVICE_NAME"
    wait_for_health
    ;;
  wait)
    require_docker
    wait_for_health
    ;;
  stop)
    require_docker
    compose stop "$SERVICE_NAME"
    ;;
  status)
    require_docker
    compose ps "$SERVICE_NAME"
    ;;
  url)
    printf '%s\n' "$TEST_DATABASE_URL"
    ;;
  env)
    printf 'export SINGULARITY_TEST_DATABASE_URL=%q\n' "$TEST_DATABASE_URL"
    printf 'export DATABASE_URL=%q\n' "$TEST_DATABASE_URL"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
