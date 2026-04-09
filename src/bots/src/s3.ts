import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFileSync, promises as fsPromises } from "fs";
import { Bot } from "./bot";
import { randomUUID } from "crypto";

/**
 * Creates an S3 Connection to the bucket.
 * 
 * @returns S3Client
 */
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

/**
 * 
 * @param s3Client 
 * @param filePath 
 */
export async function uploadRecordingToS3(s3Client: S3Client, bot: Bot): Promise<string> {

    // Attempt to read the file path. Allow for time for the file to become available.
    const filePath = bot.getRecordingPath();
    let fileContent: Buffer;
    let i = 10;

    while (true) {
        try {

            fileContent = readFileSync(filePath);
            console.log("Successfully read recording file");
            break; // Exit loop if readFileSync is successful

        } catch (error) {
            const err = error as NodeJS.ErrnoException;

            // Could not read file.

            // Busy File
            if (err.code === "EBUSY") {
                console.log("File is busy, retrying...");
                await new Promise(r => setTimeout(r, 1000)); // Wait for 1 second before retrying

                // File DNE
            } else if (err.code === "ENOENT") {

                // Throw an Error
                if (i < 0)
                    throw new Error("File not found after multiple retries");

                console.log("File not found, retrying ", i--, " more times");
                await new Promise(r => setTimeout(r, 1000)); // Wait for 1 second before retrying

                // Other Error
            } else {
                throw error; // Rethrow if it's a different error
            }
        }
    }

    // Create UUID and initialize key
    const uuid = randomUUID();
    const contentType = bot.getContentType();
    const key = `recordings/${uuid}-${bot.settings.meetingInfo.platform
        }-recording.${contentType.split("/")[1]}`;

    try {
        const commandObjects = {
            Bucket: process.env.AWS_BUCKET_NAME!,
            Key: key,
            Body: fileContent,
            ContentType: contentType,
        };

        const putCommand = new PutObjectCommand(commandObjects);
        await s3Client.send(putCommand);
        console.log(`Successfully uploaded recording to S3: ${key}`);

        // Clean up local file
        await fsPromises.unlink(filePath);

        // Return the Upload Key
        return key;

    } catch (error) {
        console.error("Error uploading to S3:", error);
    }

    // No Upload
    return '';
}