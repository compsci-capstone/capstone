import { chromium } from "playwright-extra";
import { Browser, Page } from "playwright";
import {  PageVideoCapture } from "playwright-video";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { setTimeout } from "timers/promises";
import { BotConfig, EventCode, SpeakerTimeframe, WaitingRoomTimeoutError } from "../../src/types";
import { Bot } from "../../src/bot";
import * as fs from 'fs';
import path from "path";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";

// Use Stealth Plugin to avoid detection
const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete("iframe.contentWindow");
stealthPlugin.enabledEvasions.delete("media.codecs");
chromium.use(stealthPlugin);

// User Agent Constant -- set Feb 2025
const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

// Constant Selectors
const enterNameField = 'input[type="text"][aria-label="Your name"]';
const askToJoinButton = '//button[.//span[text()="Ask to join"]]';
const joinNowButton = '//button[.//span[text()="Join now"]]';
const gotKickedDetector = '//button[.//span[text()="Return to home screen"]]';
const leaveButton = `//button[@aria-label="Leave call"]`;
const peopleButton = `//button[@aria-label="People"]`;
const onePersonRemainingField = '//span[.//div[text()="Contributors"]]//div[text()="1"]';
const muteButton = `[aria-label*="Turn off microphone"]`; // *= -> conatins
const cameraOffButton = `[aria-label*="Turn off camera"]`;

const infoPopupClick = `//button[.//span[text()="Got it"]]`;

// TODO: pass this in meeting info
const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;

type Participant = {
  id: string;
  name: string;
  observer?: MutationObserver;
};

/**
 * @param amount Milliseconds
 * @returns Random Number within 10% of the amount given, mean at amount
 */
const randomDelay = (amount: number) =>
  (2 * Math.random() - 1) * (amount / 10) + amount;

/**
 * Ensure Typescript doesn't complain about the global exposed 
 * functions that will be setup in the bot.
 */
declare global {
  interface Window {
    saveChunk: (chunk: number[]) => void;
    stopRecording: () => void;

    getParticipants: () => Participant[];
    onParticipantJoin: (participant: Participant) => void;
    onParticipantLeave: (participant: Participant) => void;
    registerParticipantSpeaking: (participant: Participant) => void;
    observeSpeech: (node: any, participant: Participant) => void;
    handleMergedAudio: () => void;

    participantArray: Participant[];
    mergedAudioParticipantArray: Participant[];
    recorder: MediaRecorder | undefined;
  }
}

/**
 * Represents a bot that can join and interact with Google Meet meetings.
 * The bot is capable of joining meetings, performing actions, recording the meeting,
 * monitoring participants, and leaving the meeting based on specific conditions.
 * 
 * @class MeetsBot
 * @extends Bot
 * 
 * @property {string[]} browserArgs - Arguments passed to the browser instance.
 * @property {string} meetingURL - The URL of the Google Meet meeting to join.
 * @property {Browser} browser - The Playwright browser instance used by the bot.
 * @property {Page} page - The Playwright page instance used by the bot.
 * @property {PageVideoCapture | undefined} recorder - The video recorder instance for capturing the meeting.
 * @property {boolean} kicked - Indicates if the bot was kicked from the meeting.
 * @property {string} recordingPath - The file path where the meeting recording is saved.
 * @property {Buffer[]} recordBuffer - Buffer to store video chunks during recording.
 * @property {boolean} startedRecording - Indicates if the recording has started.
 * @property {number} timeAloneStarted - The timestamp when the bot was the only participant in the meeting.
 * @property {ChildProcessWithoutNullStreams | null} ffmpegProcess - The ffmpeg process used for recording.
 * 
 * @constructor
 * @param {BotConfig} botSettings - Configuration settings for the bot, including meeting information.
 * @param {(eventType: EventCode, data?: any) => Promise<void>} onEvent - Callback function to handle events.
 * 
 * @method run - Runs the bot to join the meeting and perform actions.
 * @returns {Promise<void>}
 * 
 * @method getRecordingPath - Retrieves the file path of the recording.
 * @returns {string} The path to the recording file.
 * 
 * @method getSpeakerTimeframes - Retrieves the timeframes of speakers in the meeting.
 * @returns {Array} An array of objects containing speaker names and their respective start and end times.
 * 
 * @method getContentType - Retrieves the content type of the recording file.
 * @returns {string} The content type of the recording file.
 * 
 * @method joinMeeting - Joins the Google Meet meeting and performs necessary setup.
 * @returns {Promise<number>} Returns 0 if the bot successfully joins the meeting, or throws an error if it fails.
 * 
 * @method startRecording - Starts recording the meeting using ffmpeg.
 * @returns {Promise<void>}
 * 
 * @method stopRecording - Stops the ongoing recording if it has been started.
 * @returns {Promise<number>} Returns 0 if the recording was successfully stopped.
 * 
 * @method meetingActions - Performs actions during the meeting, including monitoring participants and recording.
 * @returns {Promise<number>} Returns 0 when the bot finishes its meeting actions.
 * 
 * @method leaveMeeting - Stops the recording and leaves the meeting.
 * @returns {Promise<number>} Returns 0 if the bot successfully leaves the meeting.
 */
export class MeetsBot extends Bot {
  browserArgs: string[];
  meetingURL: string;
  browser!: Browser;
  page!: Page;
  recorder: PageVideoCapture | undefined;
  kicked: boolean = false;
  recordingPath: string;
  participants: Participant[] = [];

  private registeredActivityTimestamps: {
    [participantName: string]: [number];
  } = {};
  private startedRecording: boolean = false;

  private timeAloneStarted: number = Infinity;
  private lastActivity: number | undefined = undefined;
  private recordingStartedAt: number = 0;

  private ffmpegProcess: ChildProcessWithoutNullStreams | null;

  /**
   * 
   * @param botSettings Bot Settings as Passed in the API call.
   * @param onEvent Connection to Backend
   */
  constructor(
    botSettings: BotConfig,
    onEvent: (eventType: EventCode, data?: any) => Promise<void>
  ) {
    super(botSettings, onEvent);
    this.recordingPath = path.resolve(__dirname, "recording.mp4");

    this.browserArgs = [
      "--incognito",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-infobars",
      "--disable-gpu", //disable gpu rendering

      "--use-fake-ui-for-media-stream",// automatically grants screen sharing permissions without a selection dialog.
      "--use-file-for-fake-video-capture=/dev/null",
      "--use-file-for-fake-audio-capture=/dev/null",
      '--auto-select-desktop-capture-source="Chrome"' // record the first tab automatically
    ];
    // Fetch
    this.meetingURL = botSettings.meetingInfo.meetingUrl!;
    this.kicked = false; // Flag for if the bot was kicked from the meeting, no need to click exit button.
    this.startedRecording = false; //Flag to not duplicate recording start

    this.ffmpegProcess = null;
  }

  /**
   * Run the bot to join the meeting and perform the meeting actions.
   */
  async run(): Promise<void> {
    await this.joinMeeting();
    await this.meetingActions();
  }

  /**
   * Gets a consistant video recording path
   * @returns {string} - Returns the path to the recording file.
   */
  getRecordingPath(): string {

    // Ensure the directory exists
    const dir = path.dirname(this.recordingPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Give Back the path
    return this.recordingPath;
  }

  /**
   * Gets the speaker timeframes.
   * @returns {Array} - Returns an array of objects containing speaker names and their respective start and end times.
   */
  getSpeakerTimeframes(): SpeakerTimeframe[] {
    const processedTimeframes: {
      speakerName: string;
      start: number;
      end: number;
    }[] = [];

    // If time between chunks is less than this, we consider it the same utterance.
    const utteranceThresholdMs = 3000;
    for (const [speakerName, timeframesArray] of Object.entries(
      this.registeredActivityTimestamps
    )) {
      let start = timeframesArray[0];
      let end = timeframesArray[0];

      for (let i = 1; i < timeframesArray.length; i++) {
        const currentTimeframe = timeframesArray[i]!;
        if (currentTimeframe - end < utteranceThresholdMs) {
          end = currentTimeframe;
        } else {
          if (end - start > 500) {
            processedTimeframes.push({ speakerName, start, end });
          }
          start = currentTimeframe;
          end = currentTimeframe;
        }
      }
      processedTimeframes.push({ speakerName, start, end });
    }
    processedTimeframes.sort((a, b) => a.start - b.start || a.end - b.end);

    return processedTimeframes;
  }

  /**
   * Gets the video content type.
   * @returns {string} - Returns the content type of the recording file.
   */
  getContentType(): string {
    return "video/mp4";
  }

  /**
   * Launches the browser and opens a blank page.
   */
  async launchBrowser(headless: boolean = false) {

    // Launch Browser
    this.browser = await chromium.launch({
      headless,
      args: this.browserArgs,
    });

    // Unpack Dimensions
    const vp = { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };

    // Create Browser Context
    const context = await this.browser.newContext({
      permissions: ["camera", "microphone"],
      userAgent: userAgent,
      viewport: vp
    });

    // Create Page, Go to
    this.page = await context.newPage();
  }


  /**
   * Calls Launch Browser, then navigates to join the meeting.
   * @returns 0 on success, or throws an error if it fails to join the meeting.
   */
  async joinMeeting() {

    // Launch
    await this.launchBrowser();

    //
    await this.page.waitForTimeout(randomDelay(1000));

    // Inject anti-detection code using addInitScript
    await this.page.addInitScript(() => {

      // Disable navigator.webdriver to avoid detection
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });

      // Override navigator.plugins to simulate real plugins
      Object.defineProperty(navigator, "plugins", {
        get: () => [
          { name: "Chrome PDF Plugin" },
          { name: "Chrome PDF Viewer" },
        ],
      });

      // Override navigator.languages to simulate real languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });

      // Override other properties
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4 }); // Fake number of CPU cores
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 }); // Fake memory size
      Object.defineProperty(window, "innerWidth", { get: () => SCREEN_WIDTH }); // Fake screen resolution
      Object.defineProperty(window, "innerHeight", { get: () => SCREEN_HEIGHT });
      Object.defineProperty(window, "outerWidth", { get: () => SCREEN_WIDTH });
      Object.defineProperty(window, "outerHeight", { get: () => SCREEN_HEIGHT });
    });

    //Define Bot Name
    const name = this.settings.botDisplayName || "MeetingBot";

    // Go to the meeting URL (Simulate Movement)
    await this.page.mouse.move(10, 672);
    await this.page.mouse.move(102, 872);
    await this.page.mouse.move(114, 1472);
    await this.page.waitForTimeout(300);
    await this.page.mouse.move(114, 100);
    await this.page.mouse.click(100, 100);

    //Go
    await this.page.goto(this.meetingURL, { waitUntil: "networkidle" });
    await this.page.bringToFront(); //ensure active

    console.log("Waiting for the input field to be visible...");
    await this.page.waitForSelector(enterNameField, { timeout: 15000 }); // If it can't find the enter name field in 15 seconds then something went wrong.

    console.log("Found it. Waiting for 1 second...");
    await this.page.waitForTimeout(randomDelay(1000));

    console.log("Filling the input field with the name...");
    await this.page.fill(enterNameField, name);

    console.log('Turning Off Camera and Microphone ...');
    try {
      await this.page.waitForTimeout(randomDelay(500));
      await this.page.click(muteButton, { timeout: 200 });
      await this.page.waitForTimeout(200);

    } catch (e) {
      console.log('Could not turn off Microphone, probably already off.');
    }
    try {
      await this.page.click(cameraOffButton, { timeout: 200 });
      await this.page.waitForTimeout(200);

    } catch (e) {
      console.log('Could not turn off Camera -- probably already off.');
    }

    console.log('Waiting for either the "Join now" or "Ask to join" button to appear...');
    const entryButton = await Promise.race([
      this.page.waitForSelector(joinNowButton, { timeout: 60000 }).then(() => joinNowButton),
      this.page.waitForSelector(askToJoinButton, { timeout: 60000 }).then(() => askToJoinButton),
    ]);

    await this.page.click(entryButton);

    //Should Exit after 1 Minute
    console.log("Awaiting Entry ....");
    const timeout = this.settings.automaticLeave.waitingRoomTimeout; // in milliseconds

    // wait for the leave button to appear (meaning we've joined the meeting)
    try {
      await this.page.waitForSelector(leaveButton, {
        timeout: timeout,
      });
    } catch (e) {
      // Timeout Error: Will get caught by bot/index.ts
      throw new WaitingRoomTimeoutError();
    }

    //Done. Log.
    console.log("Joined Call.");
    await this.onEvent(EventCode.JOINING_CALL);

    //Done.
    return 0;
  }

  /**
   * 
   */
  getFFmpegParams() {

    // For Testing (pnpm test) -- no docker x11 server running.
    if (!fs.existsSync('/tmp/.X11-unix')) {
      console.log('Using test ffmpeg params')
      return [
        '-y',
        '-f', 'lavfi',
        '-i', 'color=c=blue:s=1280x720:r=30',
        '-video_size', '1280x720',
        '-preset', 'ultrafast',
        '-c:a', 'aac',
        '-c:v', 'libx264',
        this.getRecordingPath()
      ]
    }

    // Creait to @martinezpl for these ffmpeg params.
    console.log('Loading Dockerized FFMPEG Params ...')

    const videoInputFormat = "x11grab";
    const audioInputFormat = "pulse";
    const videoSource = ":99.0";
    const audioSource = "default";
    const audioBitrate = "128k";
    const fps = "25";

    return [
      '-v', 'verbose', // Verbose logging for debugging
      "-thread_queue_size", "512", // Increase thread queue size to handle input buffering
      "-video_size", `${SCREEN_WIDTH}x${SCREEN_HEIGHT}`, //full screen resolution
      "-framerate", fps, // Lower frame rate to reduce CPU usage
      "-f", videoInputFormat,
      "-i", videoSource,
      "-thread_queue_size", "512",
      "-f", audioInputFormat,
      "-i", audioSource,
      "-c:v", "libx264", // H.264 codec for browser compatibility
      "-pix_fmt", "yuv420p", // Ensures compatibility with most browsers
      "-preset", "veryfast", // Use a faster preset to reduce CPU usage
      "-crf", "28", // Increase CRF for reduced CPU usage
      "-c:a", "aac", // AAC codec for audio compatibility
      "-b:a", audioBitrate, // Lower audio bitrate for reduced CPU usage
      "-vsync", "2", // Synchronize video and audio
      "-vf", "scale=1280:720", // Ensure the video is scaled to 720p
      "-y", this.getRecordingPath(), // Output file path
    ];
  }

  /**
   * Starts the recording of the call using ffmpeg.
   * 
   * This function initializes an ffmpeg process to capture the screen and audio of the meeting.
   * It ensures that only one recording process is active at a time and logs the status of the recording.
   * 
   * @returns {void}
   */
  async startRecording() {

    console.log('Attempting to start the recording ... @', this.getRecordingPath());
    if (this.ffmpegProcess) return console.log('Recording already started.');

    this.ffmpegProcess = spawn('ffmpeg', this.getFFmpegParams());

    console.log('Spawned a subprocess to record: pid=', this.ffmpegProcess.pid);

    // Report any data / errors (DEBUG, since it also prints that data is available).
    this.ffmpegProcess.stderr.on('data', (data) => {
      // console.error(`ffmpeg: ${data}`);

      // Log that we got data, and the recording started.
      if (!this.startedRecording) {
        console.log('Recording Started.');
        this.startedRecording = true;
        // Anchor speaker activity timestamps to the moment recording starts,
        // so they are relative to the recording rather than absolute epoch time.
        this.recordingStartedAt = Date.now();
      }
    });

    // Log Output of stderr
    // Log to console if the env var is set
    // Turn it on if ffmpeg gives a weird error code.
    const logFfmpeg = process.env.MEET_FFMPEG_STDERR_ECHO === 'true'
    if (logFfmpeg ?? false) {
      this.ffmpegProcess.stderr.on('data', (data) => {
        const text = data.toString();
        console.error(`ffmpeg stderr: ${text}`);
      });
    }

    // Report when the process exits
    this.ffmpegProcess.on('exit', (code) => {
      console.log(`ffmpeg exited with code ${code}`);
      this.ffmpegProcess = null;
    });

    console.log('Started FFMPEG Process.')
  }

  /**
   * Stops the ongoing recording if it has been started.
   * 
   * This function ensures that the recording process is terminated. It checks if the `ffmpegProcess`
   * exists and, if so, sends a termination signal to stop the recording. If no recording process
   * is active, it logs a message indicating that no recording was in progress.
   * 
   * @returns {Promise<number>} - Returns 0 if the recording was successfully stopped.
   */
  async stopRecording() {

    console.log('Attempting to stop the recording ...');

    // Await encoding result
    const promiseResult = await new Promise((resolve) => {

      // No recording
      if (!this.ffmpegProcess) {
        console.log('No recording in progress, cannot end recording.');
        resolve(1);
        return; // exit early
      }

      // Graceful stop
      console.log('Killing ffmpeg process gracefully ...');
      this.ffmpegProcess.kill('SIGINT'); 
      console.log('Waiting for ffmpeg to finish encoding ...');

      // Modify the exit handler to resolve the promise.
      // This will be called when the video is done encoding
      this.ffmpegProcess.on('exit', (code, signal) => {
        if (code === 0) {
          console.log('Recording stopped and file finalized.');
          resolve(0);
        } else {
          console.error(`FFmpeg exited with code ${code}${signal ? ` and signal ${signal}` : ''}`);
          resolve(1);
        }
      });
  
      // Modify the error handler to resolve the promise.
      this.ffmpegProcess.on('error', (err) => {
        console.error('Error while stopping ffmpeg:', err);
        resolve(1);
      });
    });

    // Continue
    return promiseResult;
  }

  async screenshot(fName: string = 'screenshot.png') {
    try {
      if (!this.page) throw new Error("Page not initialized");
      if (!this.browser) throw new Error("Browser not initialized");

      const screenshot = await this.page.screenshot({
        type: "png",
      });
      
      // Save the screenshot to a file
      const screenshotPath = path.resolve(`/tmp/${fName}`);
      fs.writeFileSync(screenshotPath, screenshot);
      console.log(`Screenshot saved to ${screenshotPath}`);
    } catch (error) {
      console.log('Error taking screenshot:', error);
    }
  }

  /**
   * Check if we got kicked from the meeting.
   * 
   */
  async checkKicked() {

    // Check if "Return to Home Page" button exists (Kick Condition 1)
    if (await this.page.locator(gotKickedDetector).count().catch(() => 0) > 0) {
      return true;
    }

    // console.log('Checking for hidden leave button ...')
    // Hidden Leave Button (Kick Condition 2)
    if (await this.page.locator(leaveButton).isHidden({ timeout: 500 }).catch(() => true)) {
      return true;
    }

    // console.log('Checking for removed from meeting text ...')
    // Removed from Meeting Text (Kick Condition 3)
    if (await this.page.locator('text="You\'ve been removed from the meeting"').isVisible({ timeout: 500 }).catch(() => false)) {
      return true;
    }

    // Did not get kicked if reached here.
    return false;
  }

  /**
   * Check if a pop-up appeared. If so, close it.
   */
  async handleInfoPopup(timeout = 5000) {
    try {
      await this.page.waitForSelector(infoPopupClick, { timeout });
    } catch (e) {
      return;
    }
    console.log("Clicking the popup...");
    await this.page.click(infoPopupClick);
  }

  /**
   * 
   * Meeting actions of the bot.
   * 
   * This function performs the actions that the bot is supposed to do in the meeting.
   * It first waits for the people button to be visible, then clicks on it to open the people panel.
   * It then starts recording the meeting and sets up participant monitoring.
   *  
   * Afterwards, It enters a simple loop that checks for end meeting conditions every X seconds.
   * Once detected it's done, it stops the recording and exits.
   * 
   * @returns 0
   */
  async meetingActions() {

    // Start Recording, Yes by default
    console.log("Starting Recording");
    this.startRecording();

    console.log("Waiting for the 'Others might see you differently' popup...");
    await this.handleInfoPopup();

    try {
      // UI patch: Find new people icon and click parent button
      const hasPeopleIcon = await this.page.evaluate(() => {
        const peopleButtonChild = Array.from(
          document.querySelectorAll("i")
        ).find((el) => el.textContent?.trim() === "people");
        if (peopleButtonChild) {
          const newPeopleButton = peopleButtonChild.closest("button");
          if (newPeopleButton) {
            newPeopleButton.click();
            return true;
          }
        }
        return false;
      });

      if (hasPeopleIcon) {
        console.log("Using new People button selector.");
      } else {
        console.warn("People button not found, using fallback selector.");
        await this.page.click(peopleButton);
      }

      // Wait for the people panel to be visible
      await this.page.waitForSelector('[aria-label="Participants"]', {
        state: "visible",
      });
    } catch (error) {
      console.warn("Could not click People button. Continuing anyways.");
      }

    await this.page.exposeFunction("getParticipants", () => {
      return this.participants;
    });

    await this.page.exposeFunction(
      "onParticipantJoin",
      async (participant: Participant) => {
        this.participants.push(participant);
        await this.onEvent(EventCode.PARTICIPANT_JOIN, participant);
      }
    );

    await this.page.exposeFunction(
      "onParticipantLeave",
      async (participant: Participant) => {
        await this.onEvent(EventCode.PARTICIPANT_LEAVE, participant);
        this.participants = this.participants.filter(
          (p) => p.id !== participant.id
        );
        this.timeAloneStarted =
          this.participants.length === 1 ? Date.now() : Infinity;
      }
    );

    await this.page.exposeFunction(
      "registerParticipantSpeaking",
      (participant: Participant) => {
        this.lastActivity = Date.now();
        const relativeTimestamp = Date.now() - this.recordingStartedAt;
        console.log(
          `Participant ${participant.name} is speaking at ${relativeTimestamp}ms`
        );

        if (!this.registeredActivityTimestamps[participant.name]) {
          this.registeredActivityTimestamps[participant.name] = [relativeTimestamp];
        } else {
          this.registeredActivityTimestamps[participant.name]!.push(relativeTimestamp);
        }
      }
    );

    // Add mutation observer for participant list
    // Use in the browser context to monitor for participants joining and leaving
    await this.page.evaluate(() => {
      const peopleList = document.querySelector('[aria-label="Participants"]');
      if (!peopleList) {
        console.error("Could not find participants list element");
        return;
      }

      const initialParticipants = Array.from(peopleList.childNodes).filter(
        (node) => node.nodeType === Node.ELEMENT_NODE
      );
      window.participantArray = [];
      window.mergedAudioParticipantArray = [];

      window.observeSpeech = (node, participant) => {
        console.debug("Observing speech for participant:", participant.name);
        const activityObserver = new MutationObserver((mutations) => {
          mutations.forEach(() => {
            window.registerParticipantSpeaking(participant);
          });
        });
        activityObserver.observe(node, {
          attributes: true,
          subtree: true,
          childList: true,
          attributeFilter: ["class"],
        });
        participant.observer = activityObserver;
      };

      window.handleMergedAudio = () => {
        const mergedAudioNode = document.querySelector(
          '[aria-label="Merged audio"]'
        );
        if (mergedAudioNode) {
          const detectedParticipants: Participant[] = [];
          
          // Gather all participants in the merged audio node
          mergedAudioNode.parentNode!.childNodes.forEach((childNode: any) => {
            const participantId = childNode.getAttribute("data-participant-id");
            if (!participantId) {
              return;
            }
            detectedParticipants.push({
              id: participantId,
              name: childNode.getAttribute("aria-label"),
            });
          });

          // detected new participant in the merged node
          if (
            detectedParticipants.length >
            window.mergedAudioParticipantArray.length
          ) {
            // add them
            const filteredParticipants = detectedParticipants.filter(
              (participant: Participant) =>
                !window.mergedAudioParticipantArray.find(
                  (p: Participant) => p.id === participant.id
                )
            );
            filteredParticipants.forEach((participant: Participant) => {
              const vidBlock = document.querySelector(
                `[data-requested-participant-id="${participant.id}"]`
              );
              window.mergedAudioParticipantArray.push(participant);
              window.onParticipantJoin(participant);
              window.observeSpeech(vidBlock, participant);
              window.participantArray.push(participant);
            });
          } else if (
            detectedParticipants.length <
            window.mergedAudioParticipantArray.length
          ) {
            // some participants no longer in the merged node
            const filteredParticipants =
              window.mergedAudioParticipantArray.filter(
                (participant: Participant) =>
                  !detectedParticipants.find(
                    (p: Participant) => p.id === participant.id
                  )
              );
            filteredParticipants.forEach((participant: Participant) => {
              const videoRectangle = document.querySelector(
                `[data-requested-participant-id="${participant.id}"]`
              );
              if (!videoRectangle) {
                // they've left the meeting
                window.onParticipantLeave(participant);
                window.participantArray = window.participantArray.filter(
                  (p: Participant) => p.id !== participant.id
                );
              }

              // update participants under merged audio
              window.mergedAudioParticipantArray =
                window.mergedAudioParticipantArray.filter(
                  (p: Participant) => p.id !== participant.id
                );
            });
          }
        }
      };

      initialParticipants.forEach((node: any) => {
        const participant = {
          id: node.getAttribute("data-participant-id"),
          name: node.getAttribute("aria-label"),
        };
        if (!participant.id) {
          window.handleMergedAudio();
          return;
        }
        window.onParticipantJoin(participant);
        window.observeSpeech(node, participant);
        window.participantArray.push(participant);
      });

      console.log("Setting up mutation observer on participants list");
      const peopleObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === "childList") {
            mutation.removedNodes.forEach((node: any) => {
              console.log("Removed Node", node);
              if (
                node.nodeType === Node.ELEMENT_NODE &&
                node.getAttribute &&
                node.getAttribute("data-participant-id") &&
                window.participantArray.find(
                  (p: Participant) =>
                    p.id === node.getAttribute("data-participant-id")
                )
              ) {
                console.log(
                  "Participant left:",
                  node.getAttribute("aria-label")
                );
                window.onParticipantLeave({
                  id: node.getAttribute("data-participant-id"),
                  name: node.getAttribute("aria-label"),
                });
                window.participantArray = window.participantArray.filter(
                  (p: Participant) =>
                    p.id !== node.getAttribute("data-participant-id")
                );
              } else if (
                document.querySelector('[aria-label="Merged audio"]')
              ) {
                window.handleMergedAudio();
              }
            });
          }
          mutation.addedNodes.forEach((node: any) => {
            console.log("Added Node", node);
            if (
                node.getAttribute &&
              node.getAttribute("data-participant-id") &&
              !window.participantArray.find(
                (p: Participant) =>
                  p.id === node.getAttribute("data-participant-id")
              )
              ) {
                console.log(
                "Participant joined:",
                  node.getAttribute("aria-label")
                );
                    const participant = {
                      id: node.getAttribute("data-participant-id"),
                      name: node.getAttribute("aria-label"),
                    };
              window.onParticipantJoin(participant);
              window.observeSpeech(node, participant);
              window.participantArray.push(participant);
            } else if (document.querySelector('[aria-label="Merged audio"]')) {
              window.handleMergedAudio();
              }
            });
        });
      });

      peopleObserver.observe(peopleList, { childList: true, subtree: true });
    });

    // Loop -- check for end meeting conditions every second
    console.log("Waiting until a leave condition is fulfilled..");
    while (true) {

      // Check if it's only me in the meeting
      if (this.participants.length === 1) {

        const leaveMs = this.settings?.automaticLeave?.everyoneLeftTimeout ?? 30000; // Default to 30 seconds if not set
        const msDiff = Date.now() - this.timeAloneStarted;
        console.log(`Only me left in the meeting. Waiting for timeout time to have allocated (${msDiff / 1000} / ${leaveMs / 1000}s) ...`);

        if (msDiff > leaveMs) {
          console.log('Only one participant remaining for more than alocated time, leaving the meeting.');
          break;
        }
      }

      // Got kicked -- no longer in the meeting
      // Check each of the potentials conditions
      if (await this.checkKicked()) {

        console.log('Detected that we were kicked from the meeting.');
        this.kicked = true; //store
        break; //exit loop

      }

      // Check if there has been no activity, case for when only bots stay in the meeting
      if (
        this.participants.length > 1 &&
        this.lastActivity &&
        Date.now() - this.lastActivity > this.settings.automaticLeave.inactivityTimeout
      ) {
        console.log("No Activity for 5 minutes");
        break;
      }

      await this.handleInfoPopup(1000);

      // Reset Loop
      console.log('Waiting 5 seconds.')
      await setTimeout(5000); //5 second loop
    }

    //
    // Exit
    console.log("Starting End Life Actions ...");

    try {
      await this.leaveMeeting();
      return 0;
    } catch (e) {
      await this.endLife();
      return 1;
    }
  }

  /** 
   * Clean up the meeting
   */
  async endLife() {

    // Ensure Recording is done
    console.log('Stopping Recording ...')
    await this.stopRecording();
    console.log('Done.')

    // Close my browser
    if (this.browser) {
      await this.browser.close();
      console.log("Closed Browser.");
    }

  }

  /**
   * 
   * Attempts to leave the meeting -- then cleans up.
   * 
   * @returns {Promise<number>} - Returns 0 if the bot successfully leaves the meeting, or 1 if it fails to leave the meeting.
   */
  async leaveMeeting() {

    // Try and Find the leave button, press. Otherwise, just delete the browser.
    console.log("Trying to leave the call ...")
    try {
      await this.page.click(leaveButton, { timeout: 1000 }); //Short Attempt
      console.log('Left Call.');
    } catch (e) {
      console.log('Attempted to Leave Call - couldn\'t (probably aleready left).')
    }

    console.log('Ending Life ...');
    await this.endLife();
    return 0;
  }
}
