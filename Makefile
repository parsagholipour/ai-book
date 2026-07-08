.PHONY: up down deps dbmigration-up logs-api logs-web logs-worker fix-docker-access \
	mobile-deps mobile-devices mobile-run mobile-test mobile-analyze mobile-build-apk-debug

MOBILE_DIR := apps/mobile
FLUTTER_APP_ENV ?= local
# Android emulator: 10.0.2.2 reaches host localhost. Override for a physical device LAN IP.
FLUTTER_API_BASE_URL ?= http://10.0.2.2:4001
FLUTTER_DART_DEFINES := --dart-define=APP_ENV=$(FLUTTER_APP_ENV) --dart-define=API_BASE_URL=$(FLUTTER_API_BASE_URL)

# Snap Docker cannot read projects on /run/media until removable-media is connected.
fix-docker-access:
	sudo snap connect docker:removable-media

# Always start the full stack (postgres, redis, pgadmin, api, worker, web).
up:
	@./scripts/ensure-docker-access.sh
	docker compose up -d --build postgres redis pgadmin api worker web

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

# Flutter mobile app (runs on host; start backend with `make up` first).
mobile-deps:
	cd $(MOBILE_DIR) && flutter pub get

mobile-devices:
	cd $(MOBILE_DIR) && flutter devices

# Optional: make mobile-run DEVICE=emulator-5554
# Physical device: make mobile-run FLUTTER_API_BASE_URL=http://192.168.1.143:4001
mobile-run:
	cd $(MOBILE_DIR) && flutter run$(if $(DEVICE), -d $(DEVICE),) $(FLUTTER_DART_DEFINES)

mobile-test:
	cd $(MOBILE_DIR) && flutter test

mobile-analyze:
	cd $(MOBILE_DIR) && flutter analyze

mobile-build-apk-debug:
	cd $(MOBILE_DIR) && flutter build apk --debug $(FLUTTER_DART_DEFINES)
