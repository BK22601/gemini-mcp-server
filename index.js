import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { z } from "zod";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
const httpTransports = {};
const sseTransports = new Map();

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"]
  });
});

app.post("/register", (req, res) => {
  res.status(201).json({ client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000), client_secret_expires_at: 0, ...req.body });
});

app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  const url = new URL(redirect_uri);
  url.searchParams.set("code", randomUUID());
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.post("/token", (req, res) => {
  res.json({ access_token: randomUUID(), token_type: "Bearer", expires_in: 86400 });
});

function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/.test(url);
}

function normalizeYouTubeUrl(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([a-zA-Z0-9_-]{11})/);
  if (match) return `https://www.youtube.com/watch?v=${match[1]}`;
  return url;
}

async function downloadFromGoogleDrive(fileId, destPath) {
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) throw new Error("Google Drive returned a confirmation page — make sure the file is shared as 'Anyone with the link'");
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

function buildMcpServer() {
  const server = new McpServer({ name: "gemini-video-analyzer", version: "1.0.0" });

  server.tool(
    "analyze_video",
    "Analyze a video from Google Drive or YouTube using Gemini AI",
    {
      video_url: z.string().describe("Google Drive share link or YouTube URL"),
      question: z.string().describe("What do you want to know about the video?")
    },
    async ({ video_url, question }) => {
      let tempPath = null;
      try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

        if (isYouTubeUrl(video_url)) {
          // YouTube — pass URL directly, no download needed
          const youtubeUrl = normalizeYouTubeUrl(video_url);
          console.log(`[YouTube] Analyzing: ${youtubeUrl}`);
          const result = await model.generateContent([
            { fileData: { fileUri: youtubeUrl } },
            question
          ]);
          return { content: [{ type: "text", text: result.response.text() }] };
        }

        // Google Drive — download and upload to Gemini File API
        const match = video_url.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (!match) throw new Error("Invalid link — use a Google Drive or YouTube URL");
        const fileId = match[1];

        console.log(`[Drive] Downloading file ID: ${fileId}`);
        tempPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
        await downloadFromGoogleDrive(fileId, tempPath);

        console.log(`[Drive] Uploading to Gemini File API...`);
        const upload = await fileManager.uploadFile(tempPath, { mimeType: "video/mp4", displayName: "video" });
        let file = await fileManager.getFile(upload.file.name);
        while (file.state === "PROCESSING") {
          await new Promise(r => setTimeout(r, 5000));
          file = await fileManager.getFile(upload.file.name);
        }
        if (file.state === "FAILED") throw new Error("Gemini failed to process the video");

        const result = await model.generateContent([
          { fileData: { mimeType: "video/mp4", fileUri: file.uri } },
          question
        ]);
        return { content: [{ type: "text", text: result.response.text() }] };

      } catch (err) {
        console.error(`[Error] ${err.message}`);
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      } finally {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    }
  );
  return server;
}

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;
  if (sessionId && httpTransports[sessionId]) {
    transport = httpTransports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { httpTransports[id] = transport; } });
    transport.onclose = () => { if (transport.sessionId) delete httpTransports[transport.sessionId]; };
    await buildMcpServer().connect(transport);
  } else {
    res.status(400).json({ error: "Bad request" }); return;
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const transport = httpTransports[req.headers["mcp-session-id"]];
  if (!transport) { res.status(400).json({ error: "No session" }); return; }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", (req, res) => {
  const id = req.headers["mcp-session-id"];
  if (id && httpTransports[id]) delete httpTransports[id];
  res.sendStatus(204);
});

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports.set(transport.sessionId, transport);
  res.on("close", () => sseTransports.delete(transport.sessionId));
  await buildMcpServer().connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = sseTransports.get(req.query.sessionId);
  if (transport) await transport.handlePostMessage(req, res);
  else res.status(400).send("Session not found");
});

app.get("/", (_, res) => res.send("Gemini MCP Server is running ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
