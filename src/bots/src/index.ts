import { Bot, createBot } from "./bot";
import dotenv from "dotenv";
import { startHeartbeat, reportEvent } from "./monitoring";
import { EventCode, type BotConfig } from "./types";
import { createS3Client, uploadRecordingToS3 } from "./s3";

dotenv.config({path: '../test.env'}); // Load test.env for testing
dotenv.config();

export const main = async () => {
  let hasErrorOccurred = false;
  const requiredEnvVars = [
    "BOT_DATA",
    "AWS_BUCKET_NAME",
    "AWS_REGION",
    "NODE_ENV",
  ] as const;

  // Check all required environment variables are present
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  // Parse bot data
  const botData: BotConfig = JSON.parse(process.env.BOT_DATA!);
  console.log("Received bot data:", botData);
  const botId = botData.id;

  // Declare key variable at the top level of the function
  let key: string = "";

  // Initialize S3 client
  const s3Client = createS3Client(process.env.AWS_REGION!, process.env.AWS_ACCESS_KEY_ID, process.env.AWS_SECRET_ACCESS_KEY, process.env.AWS_ENDPOINT_URL);
  if (!s3Client) {
    throw new Error("Failed to create S3 client");
  }

  // Create the appropriate bot instance based on platform
  const bot = await createBot(botData);

  // Create AbortController for heartbeat
  const heartbeatController = new AbortController();

  // Do not start heartbeat in development
  if (process.env.NODE_ENV !== "development") {
    // Start heartbeat in the background
    console.log("Starting heartbeat");
    const heartbeatInterval = botData.heartbeatInterval ?? 5000; // Default to 5 seconds if not set
    startHeartbeat(botId, heartbeatController.signal, heartbeatInterval);
  }

  // Report READY_TO_DEPLOY event
  await reportEvent(botId, EventCode.READY_TO_DEPLOY);

  try {
    // Run the bot
    await bot.run().catch(async (error) => {

      console.error("Error running bot:", error);
      await reportEvent(botId, EventCode.FATAL, {
        description: (error as Error).message,
      });

      // Check what's on the screen in case of an error
      bot.screenshot();

      // **Ensure** the bot cleans up its resources after a breaking error
      await bot.endLife();
    });

    // Upload recording to S3
    console.log("Start Upload to S3...");
    key = await uploadRecordingToS3(s3Client, bot);


  } catch (error) {
    hasErrorOccurred = true;
    console.error("Error running bot:", error);
    await reportEvent(botId, EventCode.FATAL, {
      description: (error as Error).message,
    });
  }

  // After S3 upload and cleanup, stop the heartbeat
  heartbeatController.abort();
  console.log("Bot execution completed, heartbeat stopped.");

  // Only report DONE if no error occurred
  if (!hasErrorOccurred) {
    // Report final DONE event
    const speakerTimeframes = bot.getSpeakerTimeframes();
    console.debug("Speaker timeframes:", speakerTimeframes);
    await reportEvent(botId, EventCode.DONE, { recording: key, speakerTimeframes });
  }

  // Exit with appropriate code
  process.exit(hasErrorOccurred ? 1 : 0);
};

// Only run automatically if not in a test
if (require.main === module) {
  main();
}
