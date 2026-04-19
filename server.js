import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const SHOTSTACK_API_KEY = process.env.SHOTSTACK_API_KEY;
const SHOTSTACK_RENDER_URL = process.env.SHOTSTACK_RENDER_URL || "https://api.shotstack.io/edit/stage/render";
const SHOTSTACK_STATUS_URL = process.env.SHOTSTACK_STATUS_URL || SHOTSTACK_RENDER_URL;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS || "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";
const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER || "http://localhost:4000";
const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE || "ai-video-generator";
const TTS_VOICE = process.env.TTS_VOICE || "Matthew";
const TTS_LANGUAGE = process.env.TTS_LANGUAGE || "en-US";

const SCRIPT_SYSTEM_PROMPT = [
  "You are a JSON-only generator for short video scripts.",
  "Return ONLY valid JSON. No markdown, no code fences, no explanation, no extra text.",
  "Use this exact schema:",
  '{"title":"string","scenes":[{"text":"string","duration":number}]}',
  "Rules:",
  "- Generate 3 to 5 scenes only.",
  "- Each scene text must be exactly one short sentence.",
  "- Duration must be a positive number in seconds.",
  "- Keep the title concise."
].join("\n");

function buildScriptUserPrompt(topic) {
  return `Create a short video script for this topic: ${topic}`;
}

function validateScriptJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Top-level value must be an object";
  }

  if (typeof value.title !== "string" || !value.title.trim()) {
    return "Field 'title' must be a non-empty string";
  }

  if (!Array.isArray(value.scenes)) {
    return "Field 'scenes' must be an array";
  }

  if (value.scenes.length < 3 || value.scenes.length > 5) {
    return "Field 'scenes' must contain 3 to 5 items";
  }

  for (let i = 0; i < value.scenes.length; i += 1) {
    const scene = value.scenes[i];
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      return `Scene ${i + 1} must be an object`;
    }

    if (typeof scene.text !== "string" || !scene.text.trim()) {
      return `Scene ${i + 1} field 'text' must be a non-empty string`;
    }

    if (scene.text.includes("\n")) {
      return `Scene ${i + 1} field 'text' must be a single sentence`;
    }

    if (typeof scene.duration !== "number" || Number.isNaN(scene.duration) || scene.duration <= 0) {
      return `Scene ${i + 1} field 'duration' must be a positive number`;
    }
  }

  return null;
}

function buildShotstackPayloadFromScript(script) {
  let start = 0;
  const sceneTitleClips = script.scenes.map((scene, index) => {
    const clip = {
      asset: {
        type: "title",
        text: `Scene ${index + 1}`,
        style: "minimal",
        size: "small",
        color: "#f8fafc",
        position: "center"
      },
      start,
      length: scene.duration,
      transition: {
        in: "fade",
        out: "fade"
      }
    };
    start += scene.duration;
    return clip;
  });

  start = 0;
  const subtitleClips = script.scenes.map((scene) => {
    const clip = {
      asset: {
        type: "title",
        text: scene.text,
        style: "subtitle",
        position: "bottom",
        size: "small",
        color: "#ffffff"
      },
      start,
      length: scene.duration,
      transition: {
        in: "fade",
        out: "fade"
      }
    };
    start += scene.duration;
    return clip;
  });

  start = 0;
  const voiceoverClips = script.scenes.map((scene) => {
    const clip = {
      asset: {
        type: "text-to-speech",
        text: scene.text,
        voice: TTS_VOICE,
        language: TTS_LANGUAGE
      },
      start,
      length: scene.duration
    };
    start += scene.duration;
    return clip;
  });

  return {
    timeline: {
      background: "#000000",
      tracks: [
        { clips: sceneTitleClips },
        { clips: subtitleClips },
        { clips: voiceoverClips }
      ]
    },
    output: {
      format: "mp4",
      resolution: "hd"
    }
  };
}

async function parseJsonStrict(response) {
  const text = (response?.choices?.[0]?.message?.content || "").trim();
  if (!text) {
    throw new Error("LLM returned empty content");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("LLM output is not valid JSON");
  }
}

async function callGroq(topic) {
  if (!GROQ_API_KEY) {
    throw new Error("Missing GROQ_API_KEY");
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SCRIPT_SYSTEM_PROMPT },
        { role: "user", content: buildScriptUserPrompt(topic) }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Groq error: ${JSON.stringify(data)}`);
  }

  return parseJsonStrict(data);
}

async function callOpenRouterWithModel(topic, model) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": OPENROUTER_TITLE
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SCRIPT_SYSTEM_PROMPT },
        { role: "user", content: buildScriptUserPrompt(topic) }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenRouter model '${model}' error: ${JSON.stringify(data)}`);
  }

  return parseJsonStrict(data);
}

async function callOpenRouter(topic) {
  const modelCandidates = [OPENROUTER_MODEL, ...OPENROUTER_MODELS].filter(
    (model, index, arr) => model && arr.indexOf(model) === index
  );

  const errors = [];

  for (const model of modelCandidates) {
    try {
      return await callOpenRouterWithModel(topic, model);
    } catch (error) {
      errors.push({ model, message: error.message });
    }
  }

  throw new Error(`OpenRouter failed for all models: ${JSON.stringify(errors)}`);
}

async function callOllama(topic) {
  const response = await fetch("http://localhost:11434/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SCRIPT_SYSTEM_PROMPT },
        { role: "user", content: buildScriptUserPrompt(topic) }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Ollama error: ${JSON.stringify(data)}`);
  }

  return parseJsonStrict(data);
}

async function generateScriptWithFallback(topic) {
  const providers = [
    { name: "groq", run: () => callGroq(topic) },
    { name: "openrouter", run: () => callOpenRouter(topic) },
    { name: "ollama", run: () => callOllama(topic) }
  ];

  const errors = [];

  for (const provider of providers) {
    try {
      const script = await provider.run();
      const validationError = validateScriptJson(script);
      if (validationError) {
        throw new Error(`Invalid script schema: ${validationError}`);
      }

      return { script, provider: provider.name };
    } catch (error) {
      errors.push({
        provider: provider.name,
        message: error.message
      });
    }
  }

  throw new Error(JSON.stringify(errors));
}

app.post("/generate-script", async (req, res) => {
  const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
  if (!topic) {
    return res.status(400).json({
      error: "Missing required field 'topic'"
    });
  }

  try {
    const result = await generateScriptWithFallback(topic);
    return res.status(200).json({
      provider: result.provider,
      ...result.script
    });
  } catch (error) {
    let details = [{ provider: "unknown", message: error.message }];
    try {
      details = JSON.parse(error.message);
    } catch {
      // Keep default error payload when parsing fails.
    }

    return res.status(502).json({
      error: "All LLM providers failed",
      details
    });
  }
});

app.post("/generate-video", async (req, res) => {
  if (!SHOTSTACK_API_KEY) {
    return res.status(500).json({
      error: "Missing SHOTSTACK_API_KEY in environment variables"
    });
  }

  const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
  if (!topic) {
    return res.status(400).json({
      error: "Missing required field 'topic'"
    });
  }

  let script;
  let provider;

  try {
    const result = await generateScriptWithFallback(topic);
    script = result.script;
    provider = result.provider;
  } catch (error) {
    let details = [{ provider: "unknown", message: error.message }];
    try {
      details = JSON.parse(error.message);
    } catch {
      // Keep default when parsing fails.
    }

    return res.status(502).json({
      error: "All LLM providers failed",
      details
    });
  }

  try {
    const payload = buildShotstackPayloadFromScript(script);

    const response = await fetch(SHOTSTACK_RENDER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SHOTSTACK_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Shotstack render request failed",
        details: data
      });
    }

    const renderId = data?.response?.id;
    console.log("Shotstack render ID:", renderId);

    return res.status(200).json({
      message: "Render requested",
      renderId,
      scriptProvider: provider,
      script,
      shotstackResponse: data
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error while calling Shotstack",
      details: error.message
    });
  }
});

app.get("/render-status/:id", async (req, res) => {
  if (!SHOTSTACK_API_KEY) {
    return res.status(500).json({
      error: "Missing SHOTSTACK_API_KEY in environment variables"
    });
  }

  const renderId = typeof req.params?.id === "string" ? req.params.id.trim() : "";
  if (!renderId) {
    return res.status(400).json({
      error: "Missing required render id"
    });
  }

  try {
    const response = await fetch(`${SHOTSTACK_STATUS_URL}/${renderId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SHOTSTACK_API_KEY
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Shotstack render status request failed",
        details: data
      });
    }

    return res.status(200).json({
      renderId,
      status: data?.response?.status || null,
      videoUrl: data?.response?.url || null,
      shotstackResponse: data
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error while checking Shotstack render status",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
