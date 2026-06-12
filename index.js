import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
const transports = new Map();

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
  res.status(201).json({
    client_id: randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    ...req.body
  });
});

app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  const code = randomUUID();
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.post("/token", (req, res) => {
  res.json({ access_token: randomUUID(), token_type: "Bearer", expires_in: 86400 });
});

function buildServer() {
  const server = new McpServer({ name: "gemini-video-analyzer", version: "1.0.0" });

  server.tool(
    "analyze_video",
    "Analyze a video from Google Drive using Gemini AI",
    {
      video_url: z.string().describe("Google Drive share link"),
      question: z.string().describe("What do you want to know about the video?")
    },
    async ({ video_url, question }) => {
      let tempPath = null;
      try {
        let downloadUrl = video_url;
        const match = video_url.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (match) downloadUrl = `https://drive.google.com/uc?export=download&id=${match[1]}&confirm=1`;

        tempPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
        fs.writeFileSync(tempPath, Buffer.from(await res.arrayBuffer()));

        const upload = await fileManager.uploadFile(tempPath, { mimeType: "video/mp4", displayName: "video" });
        let file = await fileManager.getFile(upload.file.name);
        while (file.state === "PROCESSING") {
          await new Promise(r => setTimeout(r, 5000));
          file = await fileManager.getFile(upload.file.name);
        }
        if (file.state ===
