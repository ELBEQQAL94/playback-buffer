const NodeMediaServer = require("node-media-server");
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const mediaDir = path.join(__dirname, "media");

// Ensure directory exists
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

// Keep track of active FFmpeg processes
const ffmpegProcesses = new Map();

// Node Media Server configuration - DISABLE built-in trans for now
const config = {
  logType: 3,
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  http: {
    port: 8001,
    mediaroot: mediaDir,
    allow_origin: "*",
  },
  // We'll handle transcoding manually since NMS trans isn't triggering
};

const nms = new NodeMediaServer(config);

// Manual FFmpeg transcoding function
function startFFmpegTranscoding(streamKey) {
  console.log("\n Starting manual FFmpeg transcoding...");
  console.log(`Stream Key: ${streamKey}`);

  const inputUrl = `rtmp://localhost:1935/live/${streamKey}`;
  const outputDir = path.join(mediaDir, "live", streamKey);

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Created directory: ${outputDir}`);
  }

  const outputPattern = path.join(outputDir, "index.m3u8");

  // FFmpeg arguments for HLS transcoding
  const ffmpegArgs = [
    "-i",
    inputUrl,
    "-c:v",
    "libx264", // Video codec
    "-c:a",
    "aac", // Audio codec
    "-b:v",
    "2500k", // Video bitrate
    "-b:a",
    "128k", // Audio bitrate
    "-vf",
    "scale=1280:720", // Scale to 720p
    "-preset",
    "veryfast", // Encoding speed
    "-g",
    "50", // GOP size
    "-sc_threshold",
    "0", // Scene change threshold
    "-f",
    "hls", // Format
    "-hls_time",
    "2", // Segment duration
    "-hls_list_size",
    "5", // Playlist size
    "-hls_flags",
    "delete_segments", // Auto-delete old segments
    "-hls_segment_filename",
    path.join(outputDir, "segment_%03d.ts"),
    outputPattern,
  ];

  console.log("\n🎬 FFmpeg Command:");
  console.log(`ffmpeg ${ffmpegArgs.join(" ")}`);
  console.log("");

  // Spawn FFmpeg process
  const ffmpeg = spawn("ffmpeg", ffmpegArgs);

  ffmpegProcesses.set(streamKey, ffmpeg);

  ffmpeg.stdout.on("data", (data) => {
    console.log(`[FFmpeg stdout]: ${data}`);
  });

  ffmpeg.stderr.on("data", (data) => {
    const message = data.toString();
    // FFmpeg outputs to stderr even for normal operation
    if (message.includes("frame=") || message.includes("time=")) {
      // Progress updates - show occasionally
      if (Math.random() < 0.1) {
        // Show ~10% of progress messages
        console.log(`[FFmpeg]: ${message.trim().substring(0, 100)}...`);
      }
    } else {
      console.log(`[FFmpeg]: ${message.trim()}`);
    }
  });

  ffmpeg.on("error", (error) => {
    console.error(`FFmpeg Error: ${error.message}`);
  });

  ffmpeg.on("close", (code) => {
    console.log(`\n⏹️  FFmpeg process exited with code ${code}`);
    ffmpegProcesses.delete(streamKey);

    if (code === 0) {
      console.log("FFmpeg finished successfully");
    } else {
      console.log("FFmpeg exited with error code:", code);
    }
  });

  // Check for files after a delay
  setTimeout(() => {
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      const m3u8Files = files.filter((f) => f.endsWith(".m3u8"));
      const tsFiles = files.filter((f) => f.endsWith(".ts"));

      if (files.length > 0) {
        console.log("\nHLS FILES CREATED!");
        console.log(`Playlist files: ${m3u8Files.join(", ")}`);
        console.log(`Video segments: ${tsFiles.length}`);
        console.log("\n========================================");
        console.log(`WATCH YOUR STREAM AT:`);
        console.log(`   http://localhost:8000/live/${streamKey}/index.m3u8`);
        console.log(`   http://localhost:8001/live/${streamKey}/index.m3u8`);
        console.log("========================================\n");
      } else {
        console.log("Directory created but waiting for segments...");
      }
    }
  }, 5000);
}

// Stop FFmpeg transcoding
function stopFFmpegTranscoding(streamKey) {
  const ffmpeg = ffmpegProcesses.get(streamKey);
  if (ffmpeg) {
    console.log(`\n Stopping FFmpeg for stream: ${streamKey}`);
    ffmpeg.kill("SIGTERM");
    ffmpegProcesses.delete(streamKey);
  }
}

// Event handlers
nms.on("preConnect", () => {
  console.log("[preConnect]");
});

nms.on("postConnect", () => {
  console.log("[postConnect]");
});

nms.on("prePublish", () => {
  console.log("\n[prePublish] Stream starting...");
});

nms.on("postPublish", () => {
  console.log("\n [postPublish] STREAM STARTED!");

  const streamKey = "demo";

  console.log(`Starting transcoding for stream: ${streamKey}`);

  setTimeout(() => {
    startFFmpegTranscoding(streamKey);
  }, 1000);
});

nms.on("donePublish", () => {
  console.log("\n⏹ [donePublish] Stream ended");

  const streamKey = "demo";
  stopFFmpegTranscoding(streamKey);
});

nms.on("transStart", () => {
  console.log("\n🔄 [transStart] Built-in transcoding started (unexpected!)");
});

nms.on("transEnd", () => {
  console.log("⏹️  [transEnd] Built-in transcoding ended");
});

nms.run();

// Express server
const app = express();
app.use(cors());

app.use(express.static(path.join(__dirname, "public")));

app.use(
  "/live",
  express.static(path.join(mediaDir, "live"), {
    setHeaders: (res, filePath) => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      if (filePath.endsWith(".m3u8")) {
        res.set("Content-Type", "application/vnd.apple.mpegurl");
      } else if (filePath.endsWith(".ts")) {
        res.set("Content-Type", "video/mp2t");
      }
    },
  })
);

const PORT = 8000;
app.listen(PORT, () => {
  console.log("\n========================================");
  console.log("SERVERS STARTED (MANUAL FFMPEG MODE)");
  console.log("========================================");
  console.log(`RTMP Server: rtmp://localhost:1935/live`);
  console.log(`Express Server: http://localhost:${PORT}`);
  console.log(`Media Directory: ${mediaDir}`);
  console.log("========================================");
  console.log("\nMANUAL FFMPEG TRANSCODING ENABLED");
  console.log("FFmpeg will be started manually on stream publish");
  console.log("\nOBS CONFIGURATION:");
  console.log("  Server: rtmp://localhost:1935/live");
  console.log("  Stream Key: demo");
  console.log(`\nStatus Dashboard: http://localhost:${PORT}`);
  console.log("========================================\n");
});

// Cleanup on exit
process.on("SIGINT", () => {
  console.log("\n\nShutting down...");
  console.log("Stopping all FFmpeg processes...");

  for (const [streamKey, ffmpeg] of ffmpegProcesses.entries()) {
    console.log(`  Stopping: ${streamKey}`);
    ffmpeg.kill("SIGTERM");
  }

  console.log("Cleanup complete");
  process.exit(0);
});
