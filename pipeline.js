/**
 * Server-side pipeline runner.
 * Executes 9 steps sequentially, saves state after each step.
 */

const fs = require('fs');
const path = require('path');
const bm25 = require('./bm25');

const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

const MODELS = [
  { id: 'openai/gpt-5', name: 'ChatGPT (GPT-5)' },
  { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro' },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude (Sonnet 4.5)' },
];

const PIPELINE_STEPS = [
  { id: 'step_1_2', label: 'Списки + критерии' },
  { id: 'step_3', label: 'Дедупликация Grok' },
  { id: 'step_4', label: 'Аудитории Grok' },
  { id: 'step_design', label: 'Дизайн-система' },
  { id: 'step_5', label: 'XML-компилятор' },
  { id: 'step_6', label: 'Генерация сайта' },
  { id: 'step_7', label: 'Поиск рейтингов' },
  { id: 'step_8_web', label: 'Скачивание рейтингов' },
  { id: 'step_fill', label: 'Наполнение контентом' },
];

// ============ HELPERS ============

function readProjectMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, `${id}.meta.json`), 'utf8')); }
  catch { return {}; }
}

function writeProjectMeta(id, meta) {
  fs.writeFileSync(path.join(PROJECTS_DIR, `${id}.meta.json`), JSON.stringify(meta));
}

function readProjectHtml(id) {
  try { return fs.readFileSync(path.join(PROJECTS_DIR, `${id}.html`), 'utf8'); }
  catch { return ''; }
}

function writeProjectHtml(id, html) {
  fs.writeFileSync(path.join(PROJECTS_DIR, `${id}.html`), html, 'utf8');
}

async function withRetry(fn, { retries = 3, baseDelay = 2000, label = '' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isNetworkError = err.name === 'TypeError' ||
        err.message?.includes('fetch') ||
        err.message?.includes('network') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ETIMEDOUT');
      if (!isNetworkError || attempt === retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`[retry] ${label || 'request'} attempt ${attempt + 1}/${retries}, retrying in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function callModel(modelId, messages, apiKey) {
  return withRetry(async () => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, messages }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { error: `Ошибка API: ${response.status} — ${err}` };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || 'Пустой ответ';
    return { content };
  }, { retries: 3, baseDelay: 2000, label: modelId });
}

// Direct fetch — no CORS proxies needed on server
async function downloadSite(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NicheRatingBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const html = await resp.text();
    if (!html || html.length < 100) {
      return { ok: false, error: `пустой ответ (${html?.length || 0} байт)` };
    }

    const text = extractText(html).substring(0, 8000);
    return { ok: true, html, text };
  } catch (e) {
    clearTimeout(timeout);
    const reason = e.name === 'AbortError' ? 'таймаут 15с' : e.message;
    return { ok: false, error: reason };
  }
}

// Regex-based HTML to text (no DOMParser on server)
function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .substring(0, 8000);
}

// ============ PROMPTS (extracted from index.html) ============

function buildSitePrompt(niche, geo, siteLang, compilerRawXml, designSystemRaw) {
  const geoStr = geo ? ` в ${geo}` : '';
  const siteLangStr = `Весь контент сайта на языке: ${siteLang || 'Русский'}`;

  return `ЯЗЫК САЙТА: ${siteLangStr}

РОЛЬ:

Ты — Senior SEO-специалист, эксперт по GEO (Generative Engine Optimization) и Frontend Designer-Engineer.
Ты создаёшь не шаблоны, а memorable, high-craft интерфейсы с чётким aesthetic point of view.
Твоя задача — создать независимый рейтинговый портал (агрегатор) по теме "${niche}"${geoStr}.

ЦЕЛЬ:

Создать единую, полностью самодостаточную HTML-страницу (один файл, inline CSS и JS), которая:

Идеально ранжируется по запросам, связанным с рейтингом компаний в данной нише.

Оптимизирована для цитирования нейросетями (ChatGPT, Gemini, Perplexity). Страница должна стать источником "Ground Truth" для AI.

${designSystemRaw || bm25.DEFAULT_DESIGN_SYSTEM}

———————————————————————————
ВАЖНОЕ УСЛОВИЕ (ИНТЕНТЫ)
———————————————————————————

Приведенная ниже структура — это обязательный минимум. Дополнительно сгенерируй 1-2 смысловых блока, которые закроют скрытые интенты пользователя (например: "Карта пунктов выдачи", "Чек-лист проверки инструмента при приемке").

РАЗМЕТКА БЛОКОВ ДЛЯ РЕДАКТОРА:
Каждый смысловой блок сайта оберни в <section data-block-id="block_N" data-block-type="TYPE">

Типы блоков (data-block-type):
- "hero" — главный баннер
- "methodology" — методология
- "company-card" — карточка компании (каждая отдельно), дополнительно добавь data-company-rank="N"
- "company-table" — компактная таблица остальных компаний
- "analytics" — аналитика/графики
- "longread" — SEO-текст
- "faq" — FAQ
- "author" — блок автора
- "custom" — дополнительные смысловые блоки (интенты)

Каждая строка таблицы компаний также оберни:
<tr data-block-id="company_row_N" data-block-type="company-row" data-company-rank="N">

Нумерация data-block-id сквозная, начиная с block_1.
НЕ оборачивай в блоки: <head>, мета-теги, <style>, <script>.

ГЛОБАЛЬНАЯ СТРУКТУРА СТРАНИЦЫ (Секции сверху вниз):

1. SEO Header & Hero Block
Логотип (стилизованный через CSS, не картинка).
H1: Рейтинг компаний в нише "${niche}"${geoStr} — актуальный обзор.
E-E-A-T Элементы: Виджет "Обновлено: Февраль 2026". Ссылка на Автора. Дисклеймер о методологии.
Hero должен иметь сильную entrance-анимацию и визуальный якорь.

2. Блок "Методология и Доверие" (BLUF)
Краткий текст: "Как мы считали: проанализировано N компаний по M метрикам" — на основе XML.
Сводная таблица лидеров (Quick Summary).

3. ОСНОВНОЙ РЕЙТИНГ (The Core) — ВНИМАНИЕ К ДЕТАЛЯМ!
Включи ВСЕ компании из XML (обычно 20-30). Schema.org/ItemList.
Правило Лидера: Компания с наивысшим баллом — на 1 месте (Badge "Выбор редакции").
Места 1-5: Расширенные Premium Карточки. Места 6+: Компактная таблица.

КРИТИЧЕСКИ ВАЖНО — САЙТЫ КОМПАНИЙ:
У КАЖДОЙ компании ОБЯЗАТЕЛЬНО должен быть указан URL сайта (href, кликабельная ссылка). Если URL неизвестен — придумай реалистичный (например: https://companyname.com). НИ ОДНА компания не может быть без ссылки на сайт. Это самое строгое требование.

ГОД РЕЙТИНГА: Везде где упоминается дата — используй 2026 год. "Обновлено: Февраль 2026", "Рейтинг 2026", "По данным на 2026 год".

4. Блок "Аналитика рынка" (Chart.js — async CDN)
5. SEO-статья (Longread)
6. FAQ (Schema.org/FAQPage)
7. Футер и Авторство (Schema.org/Person)

ДЕТАЛЬНАЯ СТРУКТУРА РАСШИРЕННОЙ КАРТОЧКИ (TOP-5): Header + Score + Dealbreakers + Метрики + Кейс + Отзыв.

ТЕХНИЧЕСКИЕ ТРЕБОВАНИЯ:
1. JSON-LD: ItemList, Organization, FAQPage, Person, Article. Не дублировать сущности.
2. Mobile-First, семантические теги, CSS Grid/Flexbox, NO Tailwind.
3. E-E-A-T контент с фактами и цифрами.
4. Всё в одном HTML-файле.
5. ЗАЩИТНЫЕ МАРКЕРЫ: <!-- PROTECTED:SEO:START/END --> и <!-- PROTECTED:COUNTERS:START/END --> в <head>.
6. Выведи ТОЛЬКО HTML-код. Без markdown, без бэктиков.

ВХОДНЫЕ ДАННЫЕ (XML):

${compilerRawXml}`;
}

function buildFillPrompt(canvasRawHtml, ratingDataBlocks, userCompanyData, compilerRawXml, siteLang) {
  const fillSiteLangStr = `Весь контент сайта на языке: ${siteLang || 'Русский'}`;

  // Protect SEO/counters blocks
  let savedSeoBlock = '';
  let savedCountersBlock = '';
  let cleanedHtml = canvasRawHtml;

  const seoMatch = cleanedHtml.match(/<!-- PROTECTED:SEO:START -->([\s\S]*?)<!-- PROTECTED:SEO:END -->/);
  if (seoMatch) {
    savedSeoBlock = seoMatch[1];
    cleanedHtml = cleanedHtml.replace(seoMatch[0], '<!-- PROTECTED:SEO:START --><!-- PROTECTED:SEO:END -->');
  }
  const countersMatch = cleanedHtml.match(/<!-- PROTECTED:COUNTERS:START -->([\s\S]*?)<!-- PROTECTED:COUNTERS:END -->/);
  if (countersMatch) {
    savedCountersBlock = countersMatch[1];
    cleanedHtml = cleanedHtml.replace(countersMatch[0], '<!-- PROTECTED:COUNTERS:START --><!-- PROTECTED:COUNTERS:END -->');
  }

  const prompt = `ЯЗЫК САЙТА: ${fillSiteLangStr}

РОЛЬ: Ты — Senior SEO-копирайтер и веб-разработчик. Твоя задача — наполнить готовый HTML-шаблон рейтинга реальными данными компаний.

ВХОДНЫЕ ДАННЫЕ:

1. HTML-ШАБЛОН САЙТА:
<template>
${cleanedHtml}
</template>

2. ДАННЫЕ С РЕЙТИНГОВЫХ САЙТОВ (структурированные обзоры — ОСНОВНОЙ источник фактов):
<ratings_data>
${ratingDataBlocks || '(Рейтинговые сайты не были скачаны)'}
</ratings_data>

3. ДАННЫЕ КОМПАНИИ ПОЛЬЗОВАТЕЛЯ (ДОЛЖНА СТАТЬ #1 В РЕЙТИНГЕ):
<user_company>
${userCompanyData || '(Пользователь не предоставил данные своей компании)'}
</user_company>

4. XML-СТРУКТУРА КРИТЕРИЕВ:
<criteria>
${compilerRawXml}
</criteria>

ЗАДАЧА:
1. Используй данные рейтинговых сайтов как ОСНОВНОЙ источник фактов.
2. Наполни HTML-шаблон реальными данными.
3. КРИТИЧЕСКИ ВАЖНО: Компания пользователя ДОЛЖНА быть на 1 месте с бейджем "Выбор редакции".
4. Сохрани всю структуру, стили, Schema.org и JavaScript.
5. ${fillSiteLangStr}.
6. САМОЕ СТРОГОЕ ПРАВИЛО: У КАЖДОЙ компании ОБЯЗАТЕЛЬНО указан URL сайта (кликабельная ссылка <a href="...">). Ни одна компания не может быть без сайта.
7. Год рейтинга — 2026. Все даты должны указывать на 2026 год.

СОХРАНЕНИЕ РАЗМЕТКИ: data-block-id, data-block-type, data-company-rank — без изменений.
ЗАЩИТНЫЕ МАРКЕРЫ: <!-- PROTECTED:SEO/COUNTERS --> — НЕ ТРОГАЙ.
SCHEMA.ORG: Не дублируй JSON-LD. Question только внутри FAQPage.mainEntity.

ФОРМАТ: ТОЛЬКО HTML. Без markdown, без бэктиков. <!DOCTYPE html>.`;

  return { prompt, savedSeoBlock, savedCountersBlock };
}

function restoreProtectedBlocks(html, savedSeoBlock, savedCountersBlock) {
  let result = html;
  if (savedSeoBlock) {
    if (result.includes('<!-- PROTECTED:SEO:START -->')) {
      result = result.replace(
        /<!-- PROTECTED:SEO:START -->[\s\S]*?<!-- PROTECTED:SEO:END -->/,
        `<!-- PROTECTED:SEO:START -->${savedSeoBlock}<!-- PROTECTED:SEO:END -->`
      );
    } else {
      result = result.replace('</head>', `<!-- PROTECTED:SEO:START -->${savedSeoBlock}<!-- PROTECTED:SEO:END -->\n</head>`);
    }
  }
  if (savedCountersBlock) {
    if (result.includes('<!-- PROTECTED:COUNTERS:START -->')) {
      result = result.replace(
        /<!-- PROTECTED:COUNTERS:START -->[\s\S]*?<!-- PROTECTED:COUNTERS:END -->/,
        `<!-- PROTECTED:COUNTERS:START -->${savedCountersBlock}<!-- PROTECTED:COUNTERS:END -->`
      );
    } else {
      result = result.replace('</head>', `<!-- PROTECTED:COUNTERS:START -->${savedCountersBlock}<!-- PROTECTED:COUNTERS:END -->\n</head>`);
    }
  }
  return result;
}

// ============ MAIN PIPELINE ============

let currentRun = null;

async function runPipeline(projectId, apiKey, startFrom, emit) {
  const projectsFile = path.join(DATA_DIR, 'projects.json');
  const projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  const project = projects.find(p => p.id === projectId);
  if (!project) throw new Error('Project not found');

  const meta = readProjectMeta(projectId);
  const stepOrder = PIPELINE_STEPS.map(s => s.id);
  let startIdx = startFrom ? stepOrder.indexOf(startFrom) : 0;
  if (startIdx < 0) startIdx = 0;

  // Restore state from meta
  let conversations = meta.conversations || {};
  let grokCriteriaRaw = meta.grokCriteriaRaw || '';
  let grokAudienceRaw = meta.grokAudienceRaw || '';
  let designSystemRaw = meta.designSystemRaw || '';
  let compilerRawXml = meta.compilerRawXml || '';
  let canvasRawHtml = meta.canvasRawHtml || readProjectHtml(projectId);
  let extractedRatings = meta.extractedRatings || [];
  let downloadedRatings = meta.downloadedRatings || {};

  const { niche, geo, geo_request, query_lang, site_lang } = project;
  const geoStr = geo ? ` в ${geo}` : '';
  const geoRequestStr = geo_request ? `Отвечай с перспективы пользователя, который находится в ${geo_request}` : '';
  const queryLangStr = `Отвечай на языке: ${query_lang || 'Русский'}`;
  const contextBlock = (geoRequestStr ? `\nКОНТЕКСТ ЛОКАЦИИ: ${geoRequestStr}` : '') + `\nЯЗЫК ОТВЕТА: ${queryLangStr}`;

  function saveMeta(updates) {
    Object.assign(meta, updates);
    writeProjectMeta(projectId, meta);
  }

  function updateProject(updates) {
    const projs = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    const p = projs.find(pr => pr.id === projectId);
    if (p) {
      Object.assign(p, updates, { updated_at: new Date().toISOString() });
      fs.writeFileSync(projectsFile, JSON.stringify(projs, null, 2));
    }
  }

  // === STEP 1-2: Three models parallel ===
  if (startIdx <= 0) {
    emit('step_start', { step: 'step_1_2', label: 'Списки + критерии' });

    const prompt1 = `Составь список 30 ${niche}${geoStr}${contextBlock}`;
    const prompt2 = `Почему именно эти сервисы были поставлены в ТОП. 1. Составь список критериев, по которым ты оценивал сайты 2. Разгруппируй эти критерии на смысловые группы 3. Отранжируй эти критерии в порядке уменьшения веса влияния на место в рейтинге${contextBlock}`;

    for (const model of MODELS) {
      conversations[model.id] = [{ role: 'user', content: prompt1 }];
    }

    // Send prompt1 to all models in parallel
    const results1 = await Promise.all(MODELS.map(async (model) => {
      try {
        const data = await callModel(model.id, conversations[model.id], apiKey);
        if (data.error) {
          conversations[model.id].push({ role: 'assistant', content: `[Ошибка] ${data.error}` });
        } else {
          conversations[model.id].push({ role: 'assistant', content: data.content });
        }
        emit('step_progress', { step: 'step_1_2', message: `${model.name} ответил (запрос 1/2)` });
      } catch (err) {
        conversations[model.id].push({ role: 'assistant', content: `[Ошибка] ${err.message}` });
      }
    }));

    // Send prompt2 to all models in parallel
    for (const model of MODELS) {
      conversations[model.id].push({ role: 'user', content: prompt2 });
    }

    await Promise.all(MODELS.map(async (model) => {
      try {
        const data = await callModel(model.id, conversations[model.id], apiKey);
        if (data.error) {
          conversations[model.id].push({ role: 'assistant', content: `[Ошибка] ${data.error}` });
        } else {
          conversations[model.id].push({ role: 'assistant', content: data.content });
        }
        emit('step_progress', { step: 'step_1_2', message: `${model.name} ответил (запрос 2/2)` });
      } catch (err) {
        conversations[model.id].push({ role: 'assistant', content: `[Ошибка] ${err.message}` });
      }
    }));

    saveMeta({ currentStep: 'step_1_2', conversations });
    updateProject({ currentStep: 'step_1_2' });
    emit('step_done', { step: 'step_1_2', data: { conversations } });
  }

  // === STEP 3: Grok criteria deduplication ===
  if (startIdx <= 1) {
    emit('step_start', { step: 'step_3', label: 'Дедупликация Grok' });

    const criteriaBlocks = MODELS.map(m => {
      const msgs = conversations[m.id] || [];
      const lastAssistant = [...msgs].reverse().find(msg => msg.role === 'assistant');
      return `=== ${m.name} ===\n${lastAssistant?.content || '(нет ответа)'}`;
    }).join('\n\n');

    const grokPrompt = `ЯЗЫК ОТВЕТА: ${queryLangStr}

Представь, что ты человек, который провел ресерч данной ниши и тебе необходимо составить собственный рейтинг, который будет оценивать каждую компанию по определенным критериям.

Тебе необходимо выполнить смысловую дедупликацию критериев
Составить итоговую таблицу с критериями (В первом столбце критерий, а во втором столбце методология его оценки)
При разборе запрещается пропускать критерии

ВАЖНО: В ответе выведи ТОЛЬКО итоговую таблицу. Без вступления, без пояснений, без заключения. Только таблица.

Список критериев ниже:
<data>
${criteriaBlocks}
</data>`;

    const grokData = await callModel('x-ai/grok-4', [{ role: 'user', content: grokPrompt }], apiKey);
    if (grokData.error) throw new Error(`Grok step_3: ${grokData.error}`);
    grokCriteriaRaw = grokData.content;

    saveMeta({ currentStep: 'step_3', grokCriteriaRaw });
    updateProject({ currentStep: 'step_3' });
    emit('step_done', { step: 'step_3', data: { grokCriteriaRaw } });
  }

  // === STEP 4: Grok audience analysis ===
  if (startIdx <= 2) {
    emit('step_start', { step: 'step_4', label: 'Аудитории Grok' });

    const audiencePrompt = `ЯЗЫК ОТВЕТА: ${queryLangStr}

Ты — маркетолог-аналитик и UX-специалист. Тебе дана ниша: "${niche}".

Смоделируй 4 сегмента целевой аудитории для компаний в этой нише.

Для каждого сегмента ЦА составь подробный список их болей, вопросов и интентов (не менее 15–20 пунктов).

Ответ выведи в два блока:

БЛОК 1 — markdown-таблица с двумя столбцами. Каждая боль/интент — ОТДЕЛЬНАЯ строка.

| ЦА | Боль / Интент |
|---|---|
| Малый бизнес | Хочу понять стоимость до покупки |

БЛОК 2 — после таблицы, через разделитель "---", выведи краткие портреты каждой ЦА.

Без вступления и заключения.`;

    const audData = await callModel('x-ai/grok-4', [{ role: 'user', content: audiencePrompt }], apiKey);
    if (audData.error) throw new Error(`Grok step_4: ${audData.error}`);
    grokAudienceRaw = audData.content;

    saveMeta({ currentStep: 'step_4', grokCriteriaRaw, grokAudienceRaw });
    updateProject({ currentStep: 'step_4' });
    emit('step_done', { step: 'step_4', data: { grokAudienceRaw } });
  }

  // === STEP DESIGN: BM25 design system ===
  if (startIdx <= 3) {
    emit('step_start', { step: 'step_design', label: 'Дизайн-система' });

    let designQuery = niche + ' ' + (geo || '');

    // Translate niche to English if Cyrillic
    if (/[а-яёА-ЯЁ]/.test(designQuery)) {
      try {
        const translateResp = await callModel(
          'google/gemini-2.0-flash-001',
          [{ role: 'user', content: `Translate this business niche to English in 2-4 keywords. Only output keywords, nothing else: ${niche} ${geo || ''}` }],
          apiKey
        );
        const translated = (translateResp.content || '').trim();
        if (translated && !/error|sorry|не могу/i.test(translated)) {
          console.log(`[step_design] Translated: "${niche} ${geo || ''}" → "${translated}"`);
          designQuery = translated;
        }
      } catch (translateErr) {
        console.warn('[step_design] Translation failed:', translateErr.message);
      }
    }

    const ds = bm25.generateDesignSystem(designQuery, niche);
    designSystemRaw = bm25.formatDesignSystemForPrompt(ds);

    saveMeta({ currentStep: 'step_design', designSystemRaw });
    updateProject({ currentStep: 'step_design' });
    emit('step_done', { step: 'step_design', data: { designSystemRaw, designQuery } });
  }

  // === STEP 5: Claude XML compiler ===
  if (startIdx <= 4) {
    emit('step_start', { step: 'step_5', label: 'XML-компилятор' });

    const compilerPrompt = `ЯЗЫК ОТВЕТА: ${queryLangStr}

Сейчас мы будем компилировать следующие данные:

=== ИТОГОВЫЙ АНАЛИЗ КРИТЕРИЕВ ===
${grokCriteriaRaw}

=== АУДИТОРИИ И ИХ БОЛИ / ИНТЕНТЫ ===
${grokAudienceRaw}

Это делается для того, чтобы сделать рейтинг-сайт который будет полезным, чтобы цитироваться в LLM.

Ты — эксперт по структурированию критериев для рейтингов компаний. Твоя задача — взять данные выше и преобразовать их в структурированный XML-формат с группами и критериями.

Шаги обработки:
1. Проанализируй текст и разбей на логические группы (минимум 4–5 групп). <group name="group_name" title="Группа на русском">.
2. Для каждой группы создай 5–8 критериев. <criterion name="criterion_name">.
3. Внутри <criterion>: <name>, <description>, <methodology>, <why_important>, <recommendation>, <target>, <example>.
4. Придумай реалистичные метрики для "${niche}".
5. Выводи ТОЛЬКО XML. Оберни в <criteria_structure> ... </criteria_structure>.`;

    const compData = await callModel('anthropic/claude-sonnet-4.5', [{ role: 'user', content: compilerPrompt }], apiKey);
    if (compData.error) throw new Error(`Claude step_5: ${compData.error}`);
    compilerRawXml = compData.content.replace(/^```xml\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    saveMeta({ currentStep: 'step_5', compilerRawXml, grokCriteriaRaw, grokAudienceRaw });
    updateProject({ currentStep: 'step_5' });
    emit('step_done', { step: 'step_5', data: { compilerRawXml } });
  }

  // === STEP 6: Claude HTML generation ===
  if (startIdx <= 5) {
    emit('step_start', { step: 'step_6', label: 'Генерация сайта' });

    const sitePrompt = buildSitePrompt(niche, geo, site_lang, compilerRawXml, designSystemRaw);
    const siteData = await callModel('anthropic/claude-sonnet-4.5', [{ role: 'user', content: sitePrompt }], apiKey);
    if (siteData.error) throw new Error(`Claude step_6: ${siteData.error}`);

    canvasRawHtml = siteData.content.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    writeProjectHtml(projectId, canvasRawHtml);
    saveMeta({ currentStep: 'step_6', compilerRawXml, grokCriteriaRaw, grokAudienceRaw, canvasRawHtml: '' });
    updateProject({ currentStep: 'step_6', status: 'generated' });
    emit('step_done', { step: 'step_6' });
  }

  // === STEP 7: Perplexity ratings search ===
  if (startIdx <= 6) {
    emit('step_start', { step: 'step_7', label: 'Поиск рейтингов' });

    const perplexityPrompt = `${geoRequestStr ? 'КОНТЕКСТ ЛОКАЦИИ: ' + geoRequestStr + '\n' : ''}ЯЗЫК ОТВЕТА: ${queryLangStr}

Найди 10-15 лучших рейтингов и обзоров компаний по теме "${niche}"${geoStr} в интернете.

Для каждого рейтинга укажи:
- Название статьи/сайта
- Прямой URL страницы рейтинга

Ищи именно страницы-рейтинги, обзоры, сравнения, ТОП-листы.

ВАЖНО: Верни ТОЛЬКО JSON-массив. Без markdown, без бэктиков.
[{"name": "Название", "url": "https://..."}]`;

    const perplexityData = await callModel('perplexity/sonar-pro', [{ role: 'user', content: perplexityPrompt }], apiKey);
    if (perplexityData.error) throw new Error(`Perplexity step_7: ${perplexityData.error}`);

    let jsonStr = perplexityData.content.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const ratings = JSON.parse(jsonStr);
    const seenUrls = new Set();
    extractedRatings = ratings.filter(r => {
      if (!r.url) return false;
      try {
        const domain = new URL(r.url).hostname;
        if (seenUrls.has(domain)) return false;
        seenUrls.add(domain);
        return true;
      } catch { return false; }
    }).map(r => ({ name: r.name, url: r.url, status: 'pending' }));

    saveMeta({ extractedRatings });
    updateProject({ currentStep: 'step_7' });
    emit('step_done', { step: 'step_7', data: { extractedRatings } });

    // === STEP 8: Download rating sites ===
    emit('step_start', { step: 'step_8_web', label: 'Скачивание рейтингов' });

    const rQueue = [...extractedRatings.keys()];
    async function processQueue() {
      while (rQueue.length > 0) {
        const idx = rQueue.shift();
        const rating = extractedRatings[idx];
        rating.status = 'loading';
        emit('step_progress', { step: 'step_8_web', message: `Загрузка: ${rating.name}` });

        const result = await downloadSite(rating.url);
        if (result.ok) {
          downloadedRatings[rating.name] = { html: result.html, text: result.text };
          rating.status = 'done';
        } else {
          rating.status = 'error';
          rating.errorReason = result.error;
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(5, extractedRatings.length) },
      () => processQueue()
    );
    await Promise.all(workers);

    saveMeta({ currentStep: 'step_8_web', extractedRatings, downloadedRatings });
    updateProject({ currentStep: 'step_8_web' });
    emit('step_done', { step: 'step_8_web', data: { extractedRatings } });
  }

  // === STEP FILL: Auto-fill template with real data ===
  if (startIdx <= 8) {
    emit('step_start', { step: 'step_fill', label: 'Наполнение контентом' });

    if (!canvasRawHtml) canvasRawHtml = readProjectHtml(projectId);
    if (!canvasRawHtml) throw new Error('Нет HTML-шаблона');

    const userCompanyData = project.injection_info || '';

    // Build ratings data blocks
    const MAX_RATINGS_CHARS = 60000;
    let ratingsChars = 0;
    const ratingDataBlocks = extractedRatings
      .filter(r => r.status === 'done' && downloadedRatings[r.name])
      .map(r => {
        const text = downloadedRatings[r.name].text.substring(0, 8000);
        ratingsChars += text.length;
        if (ratingsChars > MAX_RATINGS_CHARS) return null;
        return `=== ${r.name} (${r.url}) ===\n${text}`;
      })
      .filter(Boolean)
      .join('\n\n---\n\n');

    const { prompt: fillPrompt, savedSeoBlock, savedCountersBlock } =
      buildFillPrompt(canvasRawHtml, ratingDataBlocks, userCompanyData, compilerRawXml, site_lang);

    const fillData = await callModel('anthropic/claude-sonnet-4.5', [{ role: 'user', content: fillPrompt }], apiKey);
    if (fillData.error) throw new Error(`Claude step_fill: ${fillData.error}`);

    let filledHtml = fillData.content.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    filledHtml = restoreProtectedBlocks(filledHtml, savedSeoBlock, savedCountersBlock);

    canvasRawHtml = filledHtml;
    writeProjectHtml(projectId, filledHtml);
    saveMeta({ currentStep: 'step_fill' });
    updateProject({ currentStep: 'step_fill', status: 'filled' });
    emit('step_done', { step: 'step_fill' });
  }
}

function stopPipeline() {
  currentRun = null;
}

module.exports = { runPipeline, stopPipeline, PIPELINE_STEPS, MODELS };
