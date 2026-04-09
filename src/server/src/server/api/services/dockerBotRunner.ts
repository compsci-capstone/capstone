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
    `BACKEND_URL=http://server:${process.env.PORT ?? 3000}/api/trpc`,
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
