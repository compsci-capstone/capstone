import { createS3Client, uploadRecordingToS3 } from '../src/s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { S3Client } from '@aws-sdk/client-s3';
import { jest, it, expect, describe, afterEach, beforeEach, afterAll, beforeAll } from '@jest/globals';
import fs from 'fs';
import { BotConfig } from '../src/types';
import { Bot } from '../src/bot';

// 
// Bot Startup Tests as described in Section 2.1.2, and recording upload tests as described in 2.1.2.4,
// of our System Verification and Validation Document.
// 

// Excplicit mock build-in module required for jest to work with fs
jest.mock('fs');

describe('Bot S3 Startup Tests', () => {

    // Test that the S3 client is created with credentials when provided
    // (Local Development Example)
    it("create an S3 client with credentials when provided", () => {
        const mockRegion = "us-east-1";
        const mockAccessKeyId = "mockAccessKeyId";
        const mockSecretKey = "mockSecretKey";

        createS3Client(mockRegion, mockAccessKeyId, mockSecretKey);

        expect(S3Client).toHaveBeenCalledWith({
            region: mockRegion,
            credentials: {
                accessKeyId: mockAccessKeyId,
                secretAccessKey: mockSecretKey,
            },
        });
    });

    // Test that the S3 client is created without credentials when not provided
    // (Production Example)
    it("create an S3 client without credentials when not provided", () => {
        const mockRegion = "us-east-1";

        createS3Client(mockRegion, undefined, undefined);

        expect(S3Client).toHaveBeenCalledWith({
            region: mockRegion,
        });
    });

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

    it("Bot exits immediately if s3 config passed in is invalid", () => {
        const result = createS3Client(undefined, undefined, undefined);
        expect(result).toBeNull();
    });
});

describe('S3Client Upload Tests', () => {

    it("upload a file to S3", async () => {

        // Fake S3 Client
        const mockBucketName = "mock-bucket-name";
        const mockKey = "mock-key";
        const mockBody = "mock-body";

        const s3Client = new S3Client({});
        const putObjectCommand = new PutObjectCommand({
            Bucket: mockBucketName,
            Key: mockKey,
            Body: mockBody,
        });

        // Create a fake bot
        const mockConfig = {
            meetingInfo: {
                platform: 'mock-platform',
            },
        } as unknown as BotConfig;
        const mockOnEvent = async (eventType: string, data?: any) => { /* mock event handler */ };
        
        //Create Mock Bot
        const someBot = new Bot(mockConfig, mockOnEvent);
        someBot.getRecordingPath = jest.fn(() => 'mock-path'); // Mock the getRecordingPath method to return the mock body
        someBot.getContentType = jest.fn(() => 'mock-content-type'); // Mock the getContentType method to return the mock content type

        //
        // Test
        await uploadRecordingToS3(s3Client, someBot);
        //
        
        // Ensure the S3Client and PutObjectCommand were called with the correct parameters
        expect(PutObjectCommand).toHaveBeenCalledWith({
            Bucket: mockBucketName,
            Key: mockKey,
            Body: mockBody,
        });
        expect(s3Client.send).toHaveBeenCalledWith(putObjectCommand);
    });
});