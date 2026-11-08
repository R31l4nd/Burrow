# Burrow's everyday commands. `make help` lists them.

.DEFAULT_GOAL := help
.PHONY: help up down ps logs check gate hooks test test-int e2e lint unused typecheck build backup restore verify-backup clean reset bugs replay apk apk-keystore dev fresh-install-test

help:
	@grep -hE '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Build and start the stack
	docker compose up -d --build

down: ## Stop the stack
	docker compose --profile backup down --remove-orphans

ps: ## Container status
	docker compose --profile backup ps

logs: ## Follow the logs
	docker compose logs -f --tail=100

gate: ## The gate that must pass before a push
	bash scripts/gate.sh

check: lint unused typecheck test ## The gate's cheap steps (minutes): before every full gate

hooks: ## Install the pre-push hook
	bash scripts/install-hooks.sh

test: ## Unit tests
	bash scripts/node.sh npm test

test-int: ## Integration tests against a throwaway sshd
	bash scripts/test-integration.sh

e2e: ## End-to-end tests (Playwright, desktop + phone)
	bash scripts/e2e.sh

lint: ## ESLint, zero warnings
	bash scripts/node.sh npx eslint . --max-warnings 0

unused: ## knip: unused files, exports and dependencies
	bash scripts/node.sh npx knip --no-progress

typecheck: ## TypeScript and svelte-check
	bash scripts/node.sh sh -c 'npm run build -w @burrow/shared && npm run typecheck'

build: ## Build all workspaces
	bash scripts/node.sh npm run build

dev: ## Dev servers: API on :8080, web on :5173 (open http://localhost:5173)
	NODE_ENV_FILE=deploy/dev.env bash scripts/node.sh sh -c 'npm run build -w @burrow/shared && (npm run dev:server & npm run dev:web; wait)'

backup: ## Make a backup now (needs COMPOSE_PROFILES=backup)
	docker compose --profile backup run --rm backup /app/scripts/backup/backup.sh

verify-backup: ## Verify a backup: make verify-backup FILE=backups/burrow-<ts>.tar.gz.enc
	@test -n "$(FILE)" || { echo "Usage: make verify-backup FILE=backups/burrow-<ts>.tar.gz.enc"; exit 1; }
	docker compose --profile backup run --rm backup /app/scripts/backup/verify.sh /backups/$(notdir $(FILE))

restore: ## Restore: see scripts/restore.sh
	@echo 'Usage: bash scripts/restore.sh backups/burrow-<timestamp>.tar.gz.enc'

clean: ## Remove build output
	rm -rf shared/dist server/dist web/dist server/public e2e/test-results e2e/playwright-report
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete

# `clean` removes build output, `reset` removes DATA. Two targets on purpose:
# the first is daily work, the second cannot be undone.
reset: ## Delete all instance data (asks first)
	bash scripts/reset.sh

bugs: ## Problem reports sent from the app (newest last); make bugs ID=<id> copies one to artifacts/bugreports/
	@if [ -n "$(ID)" ]; then mkdir -p artifacts/bugreports && docker compose cp "burrow:/data/bugreports/$(ID)" artifacts/bugreports/ && cat "artifacts/bugreports/$(ID)/report.md"; \
	else docker compose exec -T burrow sh -c 'ls /data/bugreports/*/context.json >/dev/null 2>&1 || { echo "No reports yet."; exit 0; }; for d in /data/bugreports/*/; do s=open; grep -qs "\"closed\"" "$${d}status.json" && s=solved; echo "$$(basename "$$d")  $$s"; done'; fi

replay: ## Play a problem report's input recording again on the e2e setup: make replay ID=<id>
	bash scripts/replay.sh "$(ID)"

apk: ## Build the Android app and offer it for download in Burrow
	bash scripts/apk.sh

apk-keystore: ## Make the Android signing key (once; back it up)
	bash scripts/apk.sh keystore

repin: ## Pinned images that moved upstream to their new digest, and the F-Droid draft's Node with them
	bash scripts/repin.sh

fresh-install-test: ## Release test: a new Debian VM, installed per docs/INSTALL.md (needs /dev/kvm)
	bash scripts/test-fresh-install.sh

# Your installation's own targets (its deploy), when you have them: deploy/local/ is git-ignored (docs/DEV.md).
-include deploy/local/Makefile
