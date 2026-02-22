/**
 * BM25 Search Engine + Design System Generator
 * Ported from ui-ux-pro-max Python skill to Node.js
 */

const fs = require('fs');
const path = require('path');

// ============ BM25 SEARCH ENGINE ============

class BM25 {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.corpus = [];
    this.docLengths = [];
    this.avgdl = 0;
    this.idf = {};
    this.docFreqs = {};
    this.N = 0;
  }

  tokenize(text) {
    return String(text).toLowerCase().replace(/[^\w\s]/g, ' ')
      .split(/\s+/).filter(w => w.length > 2);
  }

  fit(documents) {
    this.corpus = documents.map(d => this.tokenize(d));
    this.N = this.corpus.length;
    if (this.N === 0) return;
    this.docLengths = this.corpus.map(d => d.length);
    this.avgdl = this.docLengths.reduce((a, b) => a + b, 0) / this.N;
    this.docFreqs = {};
    for (const doc of this.corpus) {
      const seen = new Set();
      for (const word of doc) {
        if (!seen.has(word)) {
          this.docFreqs[word] = (this.docFreqs[word] || 0) + 1;
          seen.add(word);
        }
      }
    }
    this.idf = {};
    for (const [word, freq] of Object.entries(this.docFreqs)) {
      this.idf[word] = Math.log((this.N - freq + 0.5) / (freq + 0.5) + 1);
    }
  }

  score(query) {
    const queryTokens = this.tokenize(query);
    const scores = [];
    for (let idx = 0; idx < this.corpus.length; idx++) {
      let score = 0;
      const doc = this.corpus[idx];
      const docLen = this.docLengths[idx];
      const termFreqs = {};
      for (const word of doc) termFreqs[word] = (termFreqs[word] || 0) + 1;
      for (const token of queryTokens) {
        if (this.idf[token] !== undefined) {
          const tf = termFreqs[token] || 0;
          const idfVal = this.idf[token];
          const num = tf * (this.k1 + 1);
          const den = tf + this.k1 * (1 - this.b + this.b * docLen / this.avgdl);
          score += idfVal * num / den;
        }
      }
      scores.push([idx, score]);
    }
    scores.sort((a, b) => b[1] - a[1]);
    return scores;
  }
}

// ============ DESIGN DATA CONFIG ============

const DESIGN_CSV_CONFIG = {
  style: {
    file: 'styles.json',
    searchCols: ['Style Category', 'Keywords', 'Best For', 'Type'],
    outputCols: ['Style Category', 'Type', 'Keywords', 'Primary Colors', 'Effects & Animation', 'Best For', 'Performance', 'Accessibility']
  },
  color: {
    file: 'colors.json',
    searchCols: ['Product Type', 'Keywords', 'Notes'],
    outputCols: ['Product Type', 'Keywords', 'Primary (Hex)', 'Secondary (Hex)', 'CTA (Hex)', 'Background (Hex)', 'Text (Hex)', 'Notes']
  },
  landing: {
    file: 'landing.json',
    searchCols: ['Pattern Name', 'Keywords', 'Conversion Optimization', 'Section Order'],
    outputCols: ['Pattern Name', 'Keywords', 'Section Order', 'Primary CTA Placement', 'Color Strategy', 'Conversion Optimization']
  },
  product: {
    file: 'products.json',
    searchCols: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Key Considerations'],
    outputCols: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Color Palette Focus']
  },
  typography: {
    file: 'typography.json',
    searchCols: ['Font Pairing Name', 'Category', 'Mood/Style Keywords', 'Best For', 'Heading Font', 'Body Font'],
    outputCols: ['Font Pairing Name', 'Heading Font', 'Body Font', 'Mood/Style Keywords', 'Best For', 'Google Fonts URL', 'CSS Import']
  }
};

const DESIGN_DATA_DIR = path.join(__dirname, 'public', 'design-data');
const designDataCache = {};

function loadDesignData(filename) {
  if (designDataCache[filename]) return designDataCache[filename];
  const filePath = path.join(DESIGN_DATA_DIR, filename);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  designDataCache[filename] = data;
  return data;
}

function searchDesignCSV(domain, query, maxResults = 3) {
  const config = DESIGN_CSV_CONFIG[domain];
  if (!config) return [];
  const data = loadDesignData(config.file);
  const documents = data.map(row =>
    config.searchCols.map(col => row[col] || '').join(' ')
  );
  const bm25 = new BM25();
  bm25.fit(documents);
  const ranked = bm25.score(query);
  return ranked.slice(0, maxResults)
    .filter(([, s]) => s > 0)
    .map(([idx]) => {
      const row = data[idx];
      const result = {};
      config.outputCols.forEach(col => { if (row[col]) result[col] = row[col]; });
      return result;
    });
}

// ============ DESIGN SYSTEM GENERATOR ============

function findReasoningRule(category, reasoningData) {
  const catLower = category.toLowerCase();
  for (const rule of reasoningData) {
    if ((rule.UI_Category || '').toLowerCase() === catLower) return rule;
  }
  for (const rule of reasoningData) {
    const uiCat = (rule.UI_Category || '').toLowerCase();
    if (uiCat.includes(catLower) || catLower.includes(uiCat)) return rule;
  }
  for (const rule of reasoningData) {
    const uiCat = (rule.UI_Category || '').toLowerCase();
    const keywords = uiCat.replace(/\//g, ' ').replace(/-/g, ' ').split(/\s+/);
    if (keywords.some(kw => kw && catLower.includes(kw))) return rule;
  }
  return null;
}

function applyReasoning(category, reasoningData) {
  const rule = findReasoningRule(category, reasoningData);
  if (!rule) {
    return {
      pattern: 'Hero + Features + CTA',
      stylePriority: ['Minimalism', 'Flat Design'],
      colorMood: 'Professional',
      typographyMood: 'Clean',
      keyEffects: 'Subtle hover transitions',
      antiPatterns: '',
      severity: 'MEDIUM'
    };
  }
  let decisionRules = {};
  try { decisionRules = JSON.parse(rule.Decision_Rules || '{}'); } catch {}
  return {
    pattern: rule.Recommended_Pattern || '',
    stylePriority: (rule.Style_Priority || '').split('+').map(s => s.trim()).filter(Boolean),
    colorMood: rule.Color_Mood || '',
    typographyMood: rule.Typography_Mood || '',
    keyEffects: rule.Key_Effects || '',
    antiPatterns: rule.Anti_Patterns || '',
    decisionRules,
    severity: rule.Severity || 'MEDIUM'
  };
}

function selectBestMatch(results, priorityKeywords) {
  if (!results.length) return {};
  if (!priorityKeywords || !priorityKeywords.length) return results[0];
  for (const priority of priorityKeywords) {
    const pLower = priority.toLowerCase().trim();
    for (const result of results) {
      const styleName = (result['Style Category'] || '').toLowerCase();
      if (pLower.includes(styleName) || styleName.includes(pLower)) return result;
    }
  }
  const scored = results.map(result => {
    const resultStr = JSON.stringify(result).toLowerCase();
    let score = 0;
    for (const kw of priorityKeywords) {
      const kwLower = kw.toLowerCase().trim();
      if ((result['Style Category'] || '').toLowerCase().includes(kwLower)) score += 10;
      else if ((result['Keywords'] || '').toLowerCase().includes(kwLower)) score += 3;
      else if (resultStr.includes(kwLower)) score += 1;
    }
    return { score, result };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].result : results[0];
}

function generateDesignSystem(query, projectName) {
  const reasoningData = loadDesignData('ui-reasoning.json');
  const productResults = searchDesignCSV('product', query, 1);
  const category = productResults[0]?.['Product Type'] || 'General';

  const reasoning = applyReasoning(category, reasoningData);
  const stylePriority = reasoning.stylePriority;

  const styleQuery = stylePriority.length
    ? `${query} ${stylePriority.slice(0, 2).join(' ')}`
    : query;

  const styleResults = searchDesignCSV('style', styleQuery, 3);
  const colorResults = searchDesignCSV('color', query, 2);
  const landingResults = searchDesignCSV('landing', query, 2);
  const typographyResults = searchDesignCSV('typography', query, 2);

  const bestStyle = selectBestMatch(styleResults, stylePriority);
  const bestColor = colorResults[0] || {};
  const bestTypography = typographyResults[0] || {};
  const bestLanding = landingResults[0] || {};

  const styleEffects = bestStyle['Effects & Animation'] || '';
  const combinedEffects = styleEffects || reasoning.keyEffects;

  return {
    projectName: projectName || query.toUpperCase(),
    category,
    pattern: {
      name: bestLanding['Pattern Name'] || reasoning.pattern || 'Hero + Features + CTA',
      sections: bestLanding['Section Order'] || 'Hero > Features > CTA',
      ctaPlacement: bestLanding['Primary CTA Placement'] || 'Above fold',
      colorStrategy: bestLanding['Color Strategy'] || '',
      conversion: bestLanding['Conversion Optimization'] || ''
    },
    style: {
      name: bestStyle['Style Category'] || 'Minimalism',
      type: bestStyle['Type'] || 'General',
      effects: styleEffects,
      keywords: bestStyle['Keywords'] || '',
      bestFor: bestStyle['Best For'] || '',
      performance: bestStyle['Performance'] || '',
      accessibility: bestStyle['Accessibility'] || ''
    },
    colors: {
      primary: bestColor['Primary (Hex)'] || '#2563EB',
      secondary: bestColor['Secondary (Hex)'] || '#3B82F6',
      cta: bestColor['CTA (Hex)'] || '#F97316',
      background: bestColor['Background (Hex)'] || '#F8FAFC',
      text: bestColor['Text (Hex)'] || '#1E293B',
      notes: bestColor['Notes'] || ''
    },
    typography: {
      heading: bestTypography['Heading Font'] || 'Inter',
      body: bestTypography['Body Font'] || 'Inter',
      mood: bestTypography['Mood/Style Keywords'] || reasoning.typographyMood || '',
      bestFor: bestTypography['Best For'] || '',
      googleFontsUrl: bestTypography['Google Fonts URL'] || '',
      cssImport: bestTypography['CSS Import'] || ''
    },
    keyEffects: combinedEffects,
    antiPatterns: reasoning.antiPatterns,
    severity: reasoning.severity
  };
}

function formatDesignSystemForPrompt(ds) {
  const antiLines = (ds.antiPatterns || '').split('+').map(p => '- ' + p.trim()).filter(l => l !== '- ').join('\n');
  return `———————————————————————————
ДИЗАЙН-СИСТЕМА (СГЕНЕРИРОВАНА АВТОМАТИЧЕСКИ ПОД НИШУ: ${ds.category})
———————————————————————————

AESTHETIC DIRECTION: ${ds.style.name} — ${ds.style.keywords || ds.style.type}
${ds.style.bestFor ? `Best For: ${ds.style.bestFor}` : ''}
${ds.style.performance ? `Performance: ${ds.style.performance} | Accessibility: ${ds.style.accessibility}` : ''}

ТИПОГРАФИКА:
- Heading: ${ds.typography.heading}
- Body: ${ds.typography.body}
- Mood: ${ds.typography.mood}
${ds.typography.cssImport ? `- CSS Import: ${ds.typography.cssImport}` : ''}
- Подключи через Google Fonts CDN с display=swap + preconnect
- Используй typography структурно: контраст размеров, ритм, иерархия через scale

ЦВЕТА (определи через CSS custom properties :root):
- Primary: ${ds.colors.primary}
- Secondary: ${ds.colors.secondary}
- CTA: ${ds.colors.cta}
- Background: ${ds.colors.background}
- Text: ${ds.colors.text}
${ds.colors.notes ? `- Notes: ${ds.colors.notes}` : ''}

ПАТТЕРН СТРАНИЦЫ: ${ds.pattern.name}
- Секции: ${ds.pattern.sections}
- CTA: ${ds.pattern.ctaPlacement}
${ds.pattern.conversion ? `- Conversion: ${ds.pattern.conversion}` : ''}
${ds.pattern.colorStrategy ? `- Color Strategy: ${ds.pattern.colorStrategy}` : ''}

MOTION И ЭФФЕКТЫ:
${ds.keyEffects || '- Subtle hover transitions (150-300ms)'}
${ds.style.effects && ds.style.effects !== ds.keyEffects ? `- ${ds.style.effects}` : ''}

АНТИ-ПАТТЕРНЫ (= ПРОВАЛ):
${antiLines}
- Дефолтные Tailwind/ShadCN layouts
- Системные шрифты (Inter, Roboto, Arial, system-ui)
- Если дизайн можно спутать с шаблоном — переделай

ДОПОЛНИТЕЛЬНЫЕ ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
- ЗАПРЕЩЕНЫ: emojis как иконки — использовать SVG (Heroicons/Lucide)
- cursor-pointer на всех кликабельных элементах
- Hover transitions: 150-300ms
- prefers-reduced-motion: reduce — отключать анимации
- Контраст текста: минимум 4.5:1 (AA)
- Focus-visible стили на интерактивных элементах
- Responsive: 375px, 768px, 1024px, 1440px
- Шрифты через Google Fonts CDN с display=swap + preconnect
- Все цвета через CSS custom properties (:root)`;
}

const DEFAULT_DESIGN_SYSTEM = `———————————————————————————
ДИЗАЙН-СИСТЕМА (ОБЯЗАТЕЛЬНАЯ К ИСПОЛНЕНИЮ)
———————————————————————————

AESTHETIC DIRECTION: Editorial / Magazine — строгий, экспертный, с характером.
Если ниша технологическая — допустим сдвиг к Industrial / Utilitarian.

ТИПОГРАФИКА (КРИТИЧЕСКИ ВАЖНО):
- ЗАПРЕЩЕНЫ: Inter, Roboto, Arial, system-ui, sans-serif по умолчанию
- Выбери 1 expressive display шрифт (например: Playfair Display, Space Grotesk, Instrument Serif, Clash Display, Syne, DM Serif Display) для заголовков
- Выбери 1 restrained body шрифт (например: Source Serif 4, Literata, IBM Plex Sans, Outfit, Satoshi) для текста
- Подключи через Google Fonts CDN
- Используй typography структурно: контраст размеров, ритм, иерархия через scale

ЦВЕТА:
- Определи все цвета через CSS custom properties (:root)
- Схема: 1 доминантный фон + 1 акцент + 1 нейтральная система (светлый/тёмный)
- ЗАПРЕЩЕНЫ: purple-on-white SaaS градиенты, равномерно-сбалансированные палитры
- Цвета должны передавать настроение: доверие, экспертность, серьёзность

ПРОСТРАНСТВО И КОМПОНОВКА:
- Ломай сетку намеренно: используй асимметрию, overlap элементов, controlled density
- Негативное пространство — это дизайн-элемент, не пустота
- ЗАПРЕЩЕНЫ: симметричные предсказуемые секции, дефолтные grid-layouts
- TOP-5 карточки должны визуально отличаться друг от друга позиционированием

MOTION И ЭФФЕКТЫ:
- Анимации: purposeful, sparse, high-impact
- 1 сильная entrance-анимация для hero-блока
- Несколько meaningful hover-состояний для карточек и CTA
- ЗАПРЕЩЕНЫ: decorative micro-motion spam, бесконечные пульсации
- CSS-first анимации. JS-анимации только если CSS недостаточно

ТЕКСТУРА И REFINEMENT:
- Используй минимум 2 из: noise/grain overlay, gradient mesh, layered translucency, custom borders/dividers, shadows с narrative intent
- Тени — не box-shadow по умолчанию, а с конкретным смыслом (глубина карточки, выделение лидера)

DIFFERENTIATION ANCHOR:
- Если убрать логотип и текст — дизайн всё равно должен быть узнаваемым
- Должен быть хотя бы 1 элемент, который запомнится через 24 часа

АНТИ-ПАТТЕРНЫ (= ПРОВАЛ):
- Дефолтные Tailwind/ShadCN layouts
- Системные шрифты
- Purple-on-white градиенты
- Симметричные секции без характера
- Если дизайн можно спутать с шаблоном — переделай

ДОПОЛНИТЕЛЬНЫЕ ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
- ЗАПРЕЩЕНЫ: emojis как иконки — использовать SVG (Heroicons/Lucide)
- cursor-pointer на всех кликабельных элементах
- Hover transitions: 150-300ms
- prefers-reduced-motion: reduce — отключать анимации
- Контраст текста: минимум 4.5:1 (AA)
- Focus-visible стили на интерактивных элементах
- Responsive: 375px, 768px, 1024px, 1440px
- Шрифты через Google Fonts CDN с display=swap + preconnect
- Все цвета через CSS custom properties (:root)`;

module.exports = {
  BM25,
  searchDesignCSV,
  generateDesignSystem,
  formatDesignSystemForPrompt,
  DEFAULT_DESIGN_SYSTEM
};
