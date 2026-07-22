import express from "express";
import { randomUUID } from "crypto";
import { writeFile, readFile, unlink } from "fs/promises";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/", (req, res) => {
  res.json({ ok: true, service: "telegram-audio-transcriber" });
});

app.post("/transcribe", async (req, res) => {
  const id = randomUUID();
  const inputPath = `/tmp/${id}.ogg`;
  const outputPath = `/tmp/${id}.mp3`;

  try {
    const { telegramFileId, telegramBotToken, audioBase64, language = "es" } = req.body || {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "missing OPENAI_API_KEY" });
    }

    let audioBuffer;

    if (telegramFileId && telegramBotToken) {
      audioBuffer = await downloadTelegramAudio(telegramBotToken, telegramFileId);
    } else if (audioBase64) {
      audioBuffer = Buffer.from(audioBase64, "base64");
    } else {
      return res.status(400).json({ ok: false, error: "missing audio" });
    }

    await writeFile(inputPath, audioBuffer);
    await runFfmpeg(inputPath, outputPath);

    const mp3 = await readFile(outputPath);

    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("language", language);
    form.append("response_format", "json");
    form.append("file", new Blob([mp3], { type: "audio/mpeg" }), "audio.mp3");

    const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json({
        ok: false,
        error: data.error?.message || data.error || data
      });
    }

    res.json({ ok: true, text: data.text || "" });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
});

async function downloadTelegramAudio(botToken, fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const info = await infoRes.json();

  if (!info.ok || !info.result?.file_path) {
    throw new Error("telegram getFile failed");
  }

  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`;
  const fileRes = await fetch(fileUrl);

  if (!fileRes.ok) {
    throw new Error(`telegram file download failed: ${fileRes.status}`);
  }

  return Buffer.from(await fileRes.arrayBuffer());
}

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-y", "-i", inputPath, "-vn", "-ar", "44100", "-ac", "1", "-b:a", "96k", outputPath]);

    let stderr = "";
    ffmpeg.stderr.on("data", chunk => stderr += chunk.toString());

    ffmpeg.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed: ${stderr.slice(-1000)}`));
    });
  });
}

app.listen(process.env.PORT || 10000, () => {
  console.log("Transcriber running");
});
