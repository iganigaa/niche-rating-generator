const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MODELS = [
  { id: "openai/gpt-5", name: "ChatGPT (GPT-5)" },
  { id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro" },
  { id: "anthropic/claude-sonnet-4.5", name: "Claude (Sonnet 4.5)" },
];

app.post("/api/search", async (req, res) => {
  const { niche, apiKey } = req.body;

  if (!niche || !apiKey) {
    return res.status(400).json({ error: "Укажите нишу и API-ключ" });
  }

  const prompt = `Составь список 30 лучших компаний ${niche}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const fetchModel = async (model) => {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return { model: model.name, modelId: model.id, error: `Ошибка API: ${response.status} — ${err}` };
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "Пустой ответ";
      return { model: model.name, modelId: model.id, content };
    } catch (err) {
      return { model: model.name, modelId: model.id, error: err.message };
    }
  };

  const results = await Promise.all(MODELS.map(fetchModel));

  for (const result of results) {
    res.write(`data: ${JSON.stringify(result)}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

app.post("/api/chat", async (req, res) => {
  const { modelId, messages, apiKey } = req.body;

  if (!modelId || !messages || !apiKey) {
    return res.status(400).json({ error: "Не хватает параметров" });
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, messages }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Ошибка API: ${response.status} — ${err}` });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "Пустой ответ";
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
