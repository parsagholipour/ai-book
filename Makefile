.PHONY: up down deps dbmigration-up logs-api logs-web logs-worker fix-docker-access

# Snap Docker cannot read projects on /run/media until removable-media is connected.
fix-docker-access:
	sudo snap connect docker:removable-media

# Always start the full stack (postgres, redis, api, worker, web).
up:
	@./scripts/ensure-docker-access.sh
	docker compose up -d --build postgres redis api worker web

down:
	docker compose down

# Reinstall deps inside Docker when node_modules volumes are stale (e.g. after adding packages).
deps:
	docker compose run --rm -e CI=true api pnpm install

dbmigration-up:
	docker compose run --rm -e CI=true api pnpm db:deploy

logs-api:
	docker compose logs -f api

logs-web:
	docker compose logs -f web

logs-worker:
	docker compose logs -f worker
