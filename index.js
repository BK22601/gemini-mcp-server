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

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
const transports = new Map();

function buildServer() {
  const server = new McpServer({
    name: "gemini-video-analyzer",
    version: "1.0.0"
  });

  server.tool(
    "analyze_video",
    "Upload a video from Google Drive and analyze it using Gemini AI",
    {
      video_url: z.string().describe("Google Drive share link to the video"),
      question: z.string().describe("What do you want to know about the video?")
    },
    async ({ video_url, question }) => {
      let tempPath = null;
      try {
        let downloadUrl = video_url;
        const match = video_url.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (match) {
          downloadUrl = `https://drive.google.com/uc?export=download&id=${match[1]}&confirm=1`;
        }

        tempPath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`Could not download video: ${res.statusText}`);
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(tempPath, Buffer.from(buffer));

        const upload = await fileManager.uploadFile(tempPath, {
          mimeType: "video/mp4",
          displayName: "video"
        });

        let file = await fileManager.getFile(upload.file.name);
        while (file.state === "PROCESSING") {
          await new Promise(r => setTimeout(r, 5000));
          file = await fileManager.getFile(upload.file.name);
        }
        if (file.state === "FAILED") throw new Error("Gemini could not process the video");

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        const result = await model.generateContent([
          { fileData: { mimeType: "video/mp4", fileUri: file.uri } },
          question
        ]);

        return { content: [{ type: "text", text: result.response.text() }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      } finally {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    }
  );

  return server;
}

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = buildServer();
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = transports.get(req.query.sessionId);
  if (transport) await transport.handlePostMessage(req, res);
  else res.status(400).send("Session not found");
});

app.get("/", (_, res) => res.send("Gemini MCP Server is running ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
