# Docker Compose Dev/Prod Workflow — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Docker Compose workflow that supports both local development and self-hosted production, replacing the AWS/Terraform dependency for users who want to run MeetingBot on a single machine.

**Architecture:** A `docker-compose.yml` at the repo root runs Postgres, MinIO (S3-compatible), and the server. Bots are not compose services — they are spawned dynamically by the server via the Docker socket using `dockerode`. A `docker-compose.override.yml` adds dev-specific overrides (build from source, hot reload, host port exposure). A root `Makefile` wraps the multi-step dev workflow into `make dev`.

**Tech Stack:** Docker Compose, MinIO, PostgreSQL 17, dockerode (npm), existing Next.js/tRPC server, existing Playwright-based bots.

**Spec:** `docs/superpowers/specs/2026-04-08-docker-compose-design.md`

---

### Task 1: Add custom endpoint support to the bots S3 client

The bots' `createS3Client` function needs to accept an optional endpoint URL so it can talk to MinIO instead of AWS S3.

**Files:**
- Modify: `src/bots/src/s3.ts:11-39`
- Modify: `src/bots/src/index.ts:35`
- Test: `src/bots/tests/s3startup.test.ts`

- [ ] **Step 1: Write failing test for endpoint support**

Add a test to `src/bots/tests/s3startup.test.ts` inside the `Bot S3 Startup Tests` describe block:

```ts
it("create an S3 client with custom endpoint when provided", () => {
    const mockRegion = "us-east-1";
    const mockAccessKeyId = "minioadmin";
    const mockSecretKey = "minioadmin";
    const mockEndpoint = "http://minio:9000";

    createS3Client(mockRegion, mockAccessKeyId, mockSecretKey, mockEndpoint);

    expect(S3Client).toHaveBeenCalledWith({
        region: mockRegion,
        credentials: {
            accessKeyId: mockAccessKeyId,
            secretAccessKey: mockSecretKey,
        },
        endpoint: mockEndpoint,
        forcePathStyle: true,
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/bots && pnpm test -- --testPathPattern=s3startup`
Expected: FAIL — `createS3Client` does not accept a 4th argument, `S3Client` not called with `endpoint`.

- [ ] **Step 3: Update `createS3Client` signature and implementation**

In `src/bots/src/s3.ts`, change the function signature and both `S3Client` constructor calls:

```ts
export function createS3Client(
    region: string | undefined,
    accessKeyId: string | undefined,
    secretKey: string | undefined,
    endpoint?: string,
): S3Client | null {
    try {
        if (!region) throw new Error("Region is required");

        const endpointConfig = endpoint
            ? { endpoint, forcePathStyle: true }
            : {};

        if (accessKeyId && secretKey) {
            return new S3Client({
                region,
                credentials: {
                    accessKeyId,
                    secretAccessKey: secretKey,
                },
                ...endpointConfig,
            });
        } else {
            return new S3Client({
                region,
                ...endpointConfig,
            });
        }
    } catch (error) {
        return null;
    }
}
```

- [ ] **Step 4: Update the call site in `src/bots/src/index.ts:35`**

Change:
```ts
const s3Client = createS3Client(process.env.AWS_REGION!, process.env.AWS_ACCESS_KEY_ID, process.env.AWS_SECRET_ACCESS_KEY);
```
To:
```ts
const s3Client = createS3Client(process.env.AWS_REGION!, process.env.AWS_ACCESS_KEY_ID, process.env.AWS_SECRET_ACCESS_KEY, process.env.AWS_ENDPOINT_URL);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/bots && pnpm test -- --testPathPattern=s3startup`
Expected: All tests PASS (existing tests pass because `endpoint` param is optional).

- [ ] **Step 6: Commit**

```bash
git add src/bots/src/s3.ts src/bots/src/index.ts src/bots/tests/s3startup.test.ts
git commit -m "feat: add custom S3 endpoint support to bots for MinIO compatibility"
```

---

### Task 2: Add custom endpoint support to the server S3 client

The server's S3 singleton also needs endpoint support, plus presigned URLs need to use an external URL so browsers can resolve them.

**Files:**
- Modify: `src/server/src/server/utils/s3.ts`
- Modify: `src/server/src/server/utils/__mocks__/s3.ts` (no changes needed — mock doesn't construct real S3Client)
- Modify: `src/server/src/env.js:36-45` (add `AWS_ENDPOINT_URL`)

- [ ] **Step 1: Add `AWS_ENDPOINT_URL` and `AWS_ENDPOINT_URL_PUBLIC` to the env schema**

In `src/server/src/env.js`, add to the `server` object (after `AWS_REGION`):

```js
AWS_ENDPOINT_URL: z.string().url().optional(),
AWS_ENDPOINT_URL_PUBLIC: z.string().url().optional(),
```

And add to the `runtimeEnv` object:

```js
AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
AWS_ENDPOINT_URL_PUBLIC: process.env.AWS_ENDPOINT_URL_PUBLIC,
```

`AWS_ENDPOINT_URL` is the Docker-internal URL (e.g., `http://minio:9000`) used for S3 operations. `AWS_ENDPOINT_URL_PUBLIC` is the browser-accessible URL (e.g., `http://localhost:9000`) used for presigned URL generation so browsers can resolve them.

- [ ] **Step 2: Update the S3 singleton to use endpoint and fix presigned URLs**

Replace the entire `src/server/src/server/utils/s3.ts`:

```ts
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "~/env";

const credentials =
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      }
    : undefined;

const endpointConfig = env.AWS_ENDPOINT_URL
  ? { endpoint: env.AWS_ENDPOINT_URL, forcePathStyle: true }
  : {};

// Internal client — used for S3 operations (upload, get, etc.)
const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials,
  ...endpointConfig,
});

// Presigned URL client — uses the public/browser-accessible endpoint.
// When AWS_ENDPOINT_URL_PUBLIC is set (e.g., http://localhost:9000 for MinIO),
// presigned URLs use that so browsers can resolve them.
// Falls back to the internal endpoint, then to default AWS behavior.
const publicEndpoint = env.AWS_ENDPOINT_URL_PUBLIC ?? env.AWS_ENDPOINT_URL;
const publicEndpointConfig = publicEndpoint
  ? { endpoint: publicEndpoint, forcePathStyle: true }
  : {};

const presignClient = new S3Client({
  region: env.AWS_REGION,
  credentials,
  ...publicEndpointConfig,
});

export const generateSignedUrl = async (key: string, expiresIn = 3600) => {
  const command = new GetObjectCommand({
    Bucket: env.AWS_BUCKET_NAME,
    Key: key,
  });

  return await getSignedUrl(presignClient, command, { expiresIn });
};
```

This uses two S3 clients: one for internal operations (pointing at `minio:9000` inside Docker) and one for presigned URL generation (pointing at `localhost:9000` so browsers can access it).

- [ ] **Step 3: Run server tests to verify nothing breaks**

Run: `cd src/server && pnpm test`
Expected: All existing tests PASS (mock is unaffected, env var is optional).

- [ ] **Step 4: Commit**

```bash
git add src/server/src/env.js src/server/src/server/utils/s3.ts
git commit -m "feat: add custom S3 endpoint support to server with presigned URL fix for MinIO"
```

---

### Task 3: Add Docker bot runner to the server

Replace the dev-mode child process spawn and add a Docker-based bot runner alongside the existing ECS runner.

**Files:**
- Modify: `src/server/package.json` (add `dockerode` + `@types/dockerode`)
- Modify: `src/server/src/env.js` (add `BOT_RUNNER`, `BOT_IMAGE_*`, `BOT_NETWORK`)
- Create: `src/server/src/server/api/services/dockerBotRunner.ts`
- Modify: `src/server/src/server/api/services/botDeployment.ts`

- [ ] **Step 1: Install dockerode**

Run: `cd src/server && pnpm add dockerode && pnpm add -D @types/dockerode`

- [ ] **Step 2: Add new env vars and make ECS vars conditional on runner**

In `src/server/src/env.js`, add the new Docker runner vars to the `server` object:

```js
BOT_RUNNER: z.enum(["docker", "ecs"]).default("ecs"),
BOT_IMAGE_MEET: z.string().optional(),
BOT_IMAGE_TEAMS: z.string().optional(),
BOT_IMAGE_ZOOM: z.string().optional(),
BOT_NETWORK: z.string().optional(),
```

**Also make the existing ECS vars always optional** (they are currently required in production). Change these six entries in the `server` object:

```js
ECS_TASK_DEFINITION_MEET: z.string().default(""),
ECS_TASK_DEFINITION_TEAMS: z.string().default(""),
ECS_TASK_DEFINITION_ZOOM: z.string().default(""),
ECS_CLUSTER_NAME: z.string().default(""),
ECS_SUBNETS: z.preprocess(
    (val) => (typeof val === "string" ? val.split(",") : []),
    z.array(z.string()),
  ).default([]),
ECS_SECURITY_GROUPS: z.preprocess(
    (val) => (typeof val === "string" ? val.split(",") : []),
    z.array(z.string()),
  ).default([]),
```

This removes the production-only requirement for ECS vars since Docker Compose also uses `NODE_ENV=production` but doesn't have ECS infrastructure.

And add to `runtimeEnv`:

```js
BOT_RUNNER: process.env.BOT_RUNNER,
BOT_IMAGE_MEET: process.env.BOT_IMAGE_MEET,
BOT_IMAGE_TEAMS: process.env.BOT_IMAGE_TEAMS,
BOT_IMAGE_ZOOM: process.env.BOT_IMAGE_ZOOM,
BOT_NETWORK: process.env.BOT_NETWORK,
```

- [ ] **Step 3: Create the Docker bot runner**

Create `src/server/src/server/api/services/dockerBotRunner.ts`:

```ts
import Docker from "dockerode";
import type { BotConfig } from "~/server/db/schema";
import type * as schema from "~/server/db/schema";
import { env } from "~/env";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

function selectBotImage(meetingInfo: schema.MeetingInfo): string {
  const platform = meetingInfo.platform?.toLowerCase();

  switch (platform) {
    case "google":
      if (!env.BOT_IMAGE_MEET) throw new Error("BOT_IMAGE_MEET not configured");
      return env.BOT_IMAGE_MEET;
    case "teams":
      if (!env.BOT_IMAGE_TEAMS) throw new Error("BOT_IMAGE_TEAMS not configured");
      return env.BOT_IMAGE_TEAMS;
    case "zoom":
      if (!env.BOT_IMAGE_ZOOM) throw new Error("BOT_IMAGE_ZOOM not configured");
      return env.BOT_IMAGE_ZOOM;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

export async function deployBotViaDocker(config: BotConfig): Promise<void> {
  const image = selectBotImage(config.meetingInfo);

  const envVars = [
    `BACKEND_URL=http://server:${env.PORT ?? 3000}/api/trpc`,
    `AWS_BUCKET_NAME=${env.AWS_BUCKET_NAME}`,
    `AWS_REGION=${env.AWS_REGION}`,
    `NODE_ENV=production`,
    `BOT_DATA=${JSON.stringify(config)}`,
  ];

  if (env.AWS_ACCESS_KEY_ID) {
    envVars.push(`AWS_ACCESS_KEY_ID=${env.AWS_ACCESS_KEY_ID}`);
  }
  if (env.AWS_SECRET_ACCESS_KEY) {
    envVars.push(`AWS_SECRET_ACCESS_KEY=${env.AWS_SECRET_ACCESS_KEY}`);
  }
  if (env.AWS_ENDPOINT_URL) {
    envVars.push(`AWS_ENDPOINT_URL=${env.AWS_ENDPOINT_URL}`);
  }

  const container = await docker.createContainer({
    Image: image,
    Env: envVars,
    HostConfig: {
      NetworkMode: env.BOT_NETWORK ?? "bridge",
      AutoRemove: true,
    },
  });

  await container.start();
}
```

- [ ] **Step 4: Update `botDeployment.ts` to use the Docker runner and lazy-init ECS**

In `src/server/src/server/api/services/botDeployment.ts`:

1. Add the import at the top:

```ts
import { deployBotViaDocker } from "./dockerBotRunner";
```

2. **Move the ECS client initialization inside the ECS code path** (currently lines 20-31 instantiate it at module scope). Remove the top-level `const config: ECSClientConfig = ...` and `const client = new ECSClient(config)` block and move the ECS client creation into a lazy getter:

```ts
let ecsClient: ECSClient | null = null;

function getECSClient(): ECSClient {
  if (!ecsClient) {
    const config: ECSClientConfig = {
      region: env.AWS_REGION,
    };

    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      config.credentials = {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      };
    }

    ecsClient = new ECSClient(config);
  }
  return ecsClient;
}
```

This avoids initializing the ECS client when `BOT_RUNNER=docker` (where ECS env vars may not exist).

3. Then replace the `if (dev) { ... } else { ... }` block inside the `try` (lines 99-151) with:

```ts
    if (env.BOT_RUNNER === "docker") {
      await deployBotViaDocker(config);
    } else if (dev) {
      // Spawn the bot process locally (legacy dev mode)
      const botProcess = spawn("pnpm", ["start"], {
        cwd: botsDir,
        env: {
          ...process.env,
          BOT_DATA: JSON.stringify(config),
        },
      });

      botProcess.stdout.on("data", (data) => {
        console.log(`Bot ${botId} stdout: ${data}`);
      });
      botProcess.stderr.on("data", (data) => {
        console.error(`Bot ${botId} stderr: ${data}`);
      });
      botProcess.on("error", (error) => {
        console.error(`Bot ${botId} process error:`, error);
      });
    } else {
      // ECS deployment (production AWS)
      const input: RunTaskRequest = {
        cluster: env.ECS_CLUSTER_NAME,
        taskDefinition: selectBotTaskDefinition(bot.meetingInfo),
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: env.ECS_SUBNETS,
            securityGroups: env.ECS_SECURITY_GROUPS,
            assignPublicIp: "ENABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: "bot",
              environment: [
                {
                  name: "BOT_DATA",
                  value: JSON.stringify(config),
                },
              ],
            },
          ],
        },
      };

      const command = new RunTaskCommand(input);
      await getECSClient().send(command);
    }
```

- [ ] **Step 5: Run server tests**

Run: `cd src/server && pnpm test`
Expected: All existing tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/package.json src/server/pnpm-lock.yaml src/server/src/env.js \
  src/server/src/server/api/services/dockerBotRunner.ts \
  src/server/src/server/api/services/botDeployment.ts
git commit -m "feat: add Docker bot runner as alternative to ECS for bot deployment"
```

---

### Task 4: Create `docker-compose.yml` (base/prod)

The production-ready compose file with Postgres, MinIO, and the server.

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `docker-compose.yml`**

Create `docker-compose.yml` at the repo root:

```yaml
name: meetingbot

services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    ports:
      - "${MINIO_PORT:-9000}:9000"
      - "${MINIO_CONSOLE_PORT:-9001}:9001"
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 5s
      retries: 5

  minio-init:
    image: minio/mc
    depends_on:
      minio:
        condition: service_healthy
    restart: "no"
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 $${MINIO_ROOT_USER} $${MINIO_ROOT_PASSWORD};
      mc mb local/$${AWS_BUCKET_NAME} --ignore-existing;
      exit 0;
      "
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      AWS_BUCKET_NAME: ${AWS_BUCKET_NAME}

  server:
    image: ${SERVER_IMAGE:-ghcr.io/meetingbot/server:latest}
    restart: unless-stopped
    command: ["sh", "-c", "pnpm db:migrate && node server.js"]
    depends_on:
      postgres:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully
    ports:
      - "${SERVER_PORT:-3000}:${SERVER_PORT:-3000}"
    environment:
      PORT: ${SERVER_PORT:-3000}
      NODE_ENV: production
      DATABASE_URL: "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
      AUTH_SECRET: ${AUTH_SECRET}
      AUTH_URL: ${AUTH_URL}
      AUTH_TRUST_HOST: "true"
      AUTH_GITHUB_ID: ${AUTH_GITHUB_ID}
      AUTH_GITHUB_SECRET: ${AUTH_GITHUB_SECRET}
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      AWS_BUCKET_NAME: ${AWS_BUCKET_NAME}
      AWS_REGION: ${AWS_REGION}
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      AWS_ENDPOINT_URL: ${AWS_ENDPOINT_URL}
      AWS_ENDPOINT_URL_PUBLIC: ${AWS_ENDPOINT_URL_PUBLIC}
      BOT_RUNNER: ${BOT_RUNNER:-docker}
      BOT_IMAGE_MEET: ${BOT_IMAGE_MEET}
      BOT_IMAGE_TEAMS: ${BOT_IMAGE_TEAMS}
      BOT_IMAGE_ZOOM: ${BOT_IMAGE_ZOOM}
      BOT_NETWORK: ${BOT_NETWORK:-meetingbot_default}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock

volumes:
  pgdata:
  minio-data:
```

- [ ] **Step 2: Verify compose file parses**

Run: `docker compose config --quiet`
Expected: exits 0, no errors (you'll need a `.env` — create a temporary one from `.env.example` first if needed).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add docker-compose.yml for prod deployment"
```

---

### Task 5: Create `docker-compose.override.yml` (dev)

Dev-specific overrides: build from source, hot reload, bot image building.

**Files:**
- Create: `docker-compose.override.yml`

- [ ] **Step 1: Create `docker-compose.override.yml`**

Create `docker-compose.override.yml` at the repo root:

```yaml
# Dev overrides — auto-applied by Docker Compose.
# For production: remove this file or rename it.
#
# To change a setting for your local setup, edit your .env file.
# This file should rarely need manual edits.

services:
  server:
    # Build from source instead of pulling a prebuilt image
    build:
      context: ./src/server
    image: meetingbot/server:dev
    environment:
      NODE_ENV: development
      SKIP_ENV_VALIDATION: "true"

  # -------------------------------------------------------
  # Bot images — built locally, never started as services.
  # These exist so `docker compose --profile bots build`
  # produces local images the server can spawn via Docker socket.
  # -------------------------------------------------------
  bot-meet:
    build:
      context: ./src/bots
      dockerfile: meet/Dockerfile
    image: ${BOT_IMAGE_MEET:-meetingbot/bots/meet:dev}
    profiles: ["bots"]

  bot-teams:
    build:
      context: ./src/bots
      dockerfile: teams/Dockerfile
    image: ${BOT_IMAGE_TEAMS:-meetingbot/bots/teams:dev}
    profiles: ["bots"]

  bot-zoom:
    build:
      context: ./src/bots
      dockerfile: zoom/Dockerfile
    image: ${BOT_IMAGE_ZOOM:-meetingbot/bots/zoom:dev}
    profiles: ["bots"]
```

- [ ] **Step 2: Verify override merges cleanly**

Run: `docker compose config --quiet`
Expected: exits 0, no errors. The server service should show `build:` context.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.override.yml
git commit -m "feat: add docker-compose.override.yml for dev workflow"
```

---

### Task 6: Create `.env.example` and `Makefile`

**Files:**
- Create: `.env.example` (repo root)
- Create: `Makefile` (repo root)

- [ ] **Step 1: Create `.env.example`**

Create `.env.example` at the repo root:

```bash
# ============================================================
# MeetingBot Docker Compose Configuration
# Copy this file to .env and fill in your values.
# ============================================================

# === Server ===
SERVER_IMAGE=ghcr.io/meetingbot/server:latest
SERVER_PORT=3000

# === Database ===
POSTGRES_USER=meetingbot
POSTGRES_PASSWORD=changeme
POSTGRES_DB=meetingbot
POSTGRES_PORT=5432

# === Auth ===
# Generate with: npx auth secret
AUTH_SECRET=generate-a-random-string
AUTH_URL=http://localhost:3000
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=

# === GitHub ===
# Token for fetching repo updates in the dashboard
GITHUB_TOKEN=

# === Storage (MinIO) ===
# MinIO acts as a local S3-compatible store.
# To use real AWS S3: set real AWS creds, remove AWS_ENDPOINT_URL,
# and optionally remove the minio/minio-init services.
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
AWS_BUCKET_NAME=meetingbot
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
AWS_ENDPOINT_URL=http://minio:9000
# Public URL for presigned URLs (must be accessible from the browser)
AWS_ENDPOINT_URL_PUBLIC=http://localhost:9000

# === Bot Runner ===
# "docker" = spawn bots via Docker socket (docker-compose mode)
# "ecs"    = spawn bots via AWS ECS (terraform mode)
BOT_RUNNER=docker
BOT_IMAGE_MEET=meetingbot/bots/meet:dev
BOT_IMAGE_TEAMS=meetingbot/bots/teams:dev
BOT_IMAGE_ZOOM=meetingbot/bots/zoom:dev
BOT_NETWORK=meetingbot_default
```

- [ ] **Step 2: Create `Makefile`**

Create `Makefile` at the repo root:

```makefile
.PHONY: dev dev-build

dev:
	docker compose --profile bots build
	docker compose up

dev-build:
	docker compose --profile bots build
	docker compose up --build
```

**Important:** The indentation in the Makefile MUST be tabs, not spaces.

- [ ] **Step 3: Verify**

Run: `make -n dev`
Expected: prints the two `docker compose` commands without executing them.

- [ ] **Step 4: Commit**

```bash
git add .env.example Makefile
git commit -m "feat: add .env.example and Makefile for docker-compose workflow"
```

---

### Task 7: Smoke test the full stack

Verify everything works end-to-end in dev mode.

**Files:** None (testing only)

- [ ] **Step 1: Create `.env` from example**

```bash
cp .env.example .env
```

Fill in `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` with valid GitHub OAuth app credentials (or use dummy values if just testing infrastructure comes up).

- [ ] **Step 2: Build and start**

Run: `make dev`

Expected:
- Postgres starts and becomes healthy
- MinIO starts, `minio-init` creates the bucket and exits
- Server runs migrations and starts on port 3000
- No errors in logs

- [ ] **Step 3: Verify MinIO bucket**

Open: `http://localhost:9001` (MinIO console)
Login with `minioadmin` / `minioadmin`.
Expected: `meetingbot` bucket exists.

- [ ] **Step 4: Verify server is running**

Open: `http://localhost:3000`
Expected: MeetingBot dashboard loads (may redirect to login).

- [ ] **Step 5: Tear down**

Run: `docker compose down`

- [ ] **Step 6: Commit any fixes discovered during smoke test**

If any changes were needed, commit them with a descriptive message.
