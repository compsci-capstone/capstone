# Docker Compose Dev/Prod Workflow

Replace the AWS/Terraform-only deployment path with a Docker Compose workflow that supports both local development and self-hosted production on a single machine, with no AWS dependency.

## Decisions

- **Bot spawning:** Server mounts the Docker socket and uses `dockerode` to spawn ephemeral bot containers on-demand (same lifecycle as current ECS Fargate tasks).
- **Storage:** MinIO (S3-compatible) runs as a compose service. Existing AWS SDK code works unchanged — only the endpoint URL differs. Users who want real S3 can omit MinIO and point at AWS.
- **Database:** Postgres 17 runs as a compose service with a named volume.
- **Dev vs prod:** `docker-compose.yml` (base, prod-ready) + `docker-compose.override.yml` (dev overrides, auto-applied). Override file is well-commented so it doubles as documentation.
- **Bot image builds:** Dev override defines bot services behind a `bots` profile so they build locally but never start as long-running services. A root `Makefile` wraps the two-step workflow into `make dev`.

## File Structure

```
meetingbot/
├── docker-compose.yml              # base (prod-ready, prebuilt images)
├── docker-compose.override.yml     # dev overrides (auto-applied, well-commented)
├── .env.example                    # all variables with comments, copy to .env
└── Makefile                        # dev/dev-build commands
```

## Services

### docker-compose.yml (base)

| Service      | Image              | Purpose                                      |
|--------------|--------------------|----------------------------------------------|
| `postgres`   | `postgres:17`      | Database, data persisted via named volume     |
| `minio`      | `minio/minio`      | S3-compatible storage, named volume           |
| `minio-init` | `minio/mc`         | One-shot: creates the bucket on first run     |
| `server`     | `${SERVER_IMAGE}`  | Next.js server + tRPC API                     |

Bot containers are **not** compose services. They are spawned dynamically by the server via the Docker socket.

### docker-compose.override.yml (dev)

Overrides applied automatically in dev:

- `server`: `build:` from `./src/server` instead of a prebuilt image, source code volume mounts for hot reload
- Exposes Postgres (5432) and MinIO console (9001) ports to the host for debugging
- Bot build services behind `profiles: ["bots"]`:

```yaml
bot-meet:
  build: ./src/bots/meet
  image: meetingbot/bots/meet:dev
  profiles: ["bots"]
bot-teams:
  build: ./src/bots/teams
  image: meetingbot/bots/teams:dev
  profiles: ["bots"]
bot-zoom:
  build: ./src/bots/zoom
  image: meetingbot/bots/zoom:dev
  profiles: ["bots"]
```

## Environment Variables

Single `.env.example` at the repo root. Variables are defined once in `.env` and referenced in compose via `${VAR}` interpolation to avoid duplication.

```bash
# === Server ===
SERVER_IMAGE=ghcr.io/meetingbot/server:latest
SERVER_PORT=3000

# === Database ===
POSTGRES_USER=meetingbot
POSTGRES_PASSWORD=changeme
POSTGRES_DB=meetingbot
POSTGRES_PORT=5432

# === Auth ===
AUTH_SECRET=generate-a-random-string
AUTH_URL=http://localhost:3000
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=

# === Storage (MinIO) ===
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
AWS_BUCKET_NAME=meetingbot
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
AWS_ENDPOINT_URL=http://minio:9000

# === Bot Runner ===
BOT_RUNNER=docker
BOT_IMAGE_MEET=meetingbot/bots/meet:dev
BOT_IMAGE_TEAMS=meetingbot/bots/teams:dev
BOT_IMAGE_ZOOM=meetingbot/bots/zoom:dev
BOT_NETWORK=meetingbot_default
```

`DATABASE_URL` is composed inside the compose file from the `POSTGRES_*` vars, not set by hand.

To use real S3 instead of MinIO: set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` to real AWS credentials, remove or blank `AWS_ENDPOINT_URL`, and optionally remove the `minio` and `minio-init` services.

## Networking

- All compose services join the default `meetingbot_default` network.
- Spawned bot containers are attached to the same network via the `BOT_NETWORK` env var.
- Bots reach the server at `http://server:${SERVER_PORT}/api/trpc` and MinIO at `http://minio:${MINIO_PORT}`.

## Database Migrations

The server container's command is overridden to run migrations before starting:

```yaml
server:
  command: ["sh", "-c", "pnpm db:migrate && node server.js"]
  depends_on:
    postgres:
      condition: service_healthy
```

Migrations run on every startup. If they fail, the server does not start.

## Bot Spawning — Server Code Changes

This is the only application code change. Everything else is compose config and env vars.

### What changes

- Add `dockerode` as a dependency to the server.
- New `DockerBotRunner` implementation alongside the existing ECS runner.
- `BOT_RUNNER` env var selects the runner (`docker` or `ecs`).
- The runner interface is the same: "start a bot container with these env vars for this meeting."

### Docker runner behavior

```ts
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const container = await docker.createContainer({
  Image: process.env.BOT_IMAGE_MEET,  // or TEAMS/ZOOM based on platform
  Env: [
    `BACKEND_URL=http://server:${process.env.SERVER_PORT}/api/trpc`,
    `AWS_BUCKET_NAME=${process.env.AWS_BUCKET_NAME}`,
    `AWS_REGION=${process.env.AWS_REGION}`,
    `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID}`,
    `AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY}`,
    `AWS_ENDPOINT_URL=${process.env.AWS_ENDPOINT_URL}`,
    'NODE_ENV=production',
    // plus meeting-specific vars (meeting URL, bot ID, etc.)
  ],
  HostConfig: {
    NetworkMode: process.env.BOT_NETWORK,
    AutoRemove: true,
  },
});
await container.start();
```

### What stays the same

- All S3/storage code (MinIO is S3-compatible)
- All database code (still Postgres, still Drizzle)
- All auth code
- All tRPC routes
- All bot code (bots don't know or care whether ECS or Docker started them)

## Makefile

```makefile
dev:
	docker compose --profile bots build
	docker compose up

dev-build:
	docker compose --profile bots build
	docker compose up --build
```

`make dev` — single command for local development. Builds bot images, then starts all services.
`make dev-build` — also rebuilds the server image.

## Prod Usage

For self-hosted production on a VPS:

1. Copy `.env.example` to `.env`, fill in real values (strong passwords, real auth credentials).
2. Remove `docker-compose.override.yml` (or don't create it).
3. Run `docker compose up -d`.

The base compose file pulls prebuilt images and runs everything. No build step needed.
