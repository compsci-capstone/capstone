.PHONY: dev dev-build

dev:
	docker compose --profile bots build
	docker compose up

dev-build:
	docker compose --profile bots build
	docker compose up --build
