'use strict';

const params = new URLSearchParams(location.search);

const DEFAULT_FEEDS = [
  { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'World', priority: 1, enabled: true, includeInRotation: true },
  { id: 'sky', name: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/home.xml', category: 'Top Stories', priority: 2, enabled: true, includeInRotation: true },
  { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'Technology', priority: 3, enabled: true, includeInRotation: true },
  { id: 'ars', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'Technology', priority: 4, enabled: true, includeInRotation: true },
];

const CATEGORY_IMAGES = {
  business: 'linear-gradient(135deg, #121923, #334250 58%, #c9a35a)',
  science: 'linear-gradient(135deg, #061d25, #175462 58%, #70d6e3)',
  sport: 'linear-gradient(135deg, #0b1f18, #236b44 58%, #d7f58a)',
  technology: 'linear-gradient(135deg, #081525, #1b446d 58%, #8dc8ff)',
  world: 'linear-gradient(135deg, #181923, #314052 58%, #f1f4f8)',
};

const SOURCE_COLORS = [
  { pattern: /\bbbc\b/i, color: '#d71920' },
  { pattern: /\bsky\b/i, color: '#0072ce' },
  { pattern: /\breuters\b/i, color: '#ff8000' },
  { pattern: /\bcnn\b/i, color: '#cc0000' },
  { pattern: /\bthe verge\b|\bverge\b/i, color: '#fa4b8b' },
  { pattern: /\bars technica\b|\bars\b/i, color: '#ff4e00' },
  { pattern: /\bassociated press\b|\bap\b/i, color: '#ff322e' },
  { pattern: /\bguardian\b/i, color: '#052962' },
  { pattern: /\bfinancial times\b|\bft\b/i, color: '#f6b895' },
  { pattern: /\bnasa\b/i, color: '#2d7dd2' },
];

const settings = {
  feeds: parseFeeds(params.get('feeds')),
  storyDuration: clampNumber(params.get('storyDuration'), 10, 60, 15),
  showSummary: readBool(params.get('showSummary'), true),
  showPublishedTime: readBool(params.get('showPublishedTime'), true),
  showCategory: readBool(params.get('showCategory'), true),
  showStoryCounter: readBool(params.get('showStoryCounter'), true),
  enableKenBurns: readBool(params.get('enableKenBurns'), false),
  enableBreakingNews: readBool(params.get('enableBreakingNews'), true),
  refreshIntervalMinutes: clampNumber(params.get('refreshIntervalMinutes'), 1, 240, 15),
};

const els = {
  shell: document.getElementById('app'),
  imageA: document.getElementById('storyImageA'),
  imageB: document.getElementById('storyImageB'),
  headline: document.getElementById('headline'),
  breaking: document.getElementById('breakingBadge'),
  source: document.getElementById('source'),
  category: document.getElementById('category'),
  published: document.getElementById('published'),
  summary: document.getElementById('summary'),
  counter: document.getElementById('counter'),
  refresh: document.getElementById('refreshStatus'),
  empty: document.getElementById('emptyState'),
  emptyStatus: document.getElementById('emptyStatus'),
};

const state = {
  stories: [],
  errors: [],
  index: 0,
  activeImage: 0,
  rotateTimer: null,
  refreshTimer: null,
  lastRefreshAt: null,
  isTransitioning: false,
};

document.documentElement.style.setProperty('--story-seconds', `${settings.storyDuration}s`);
els.shell.classList.toggle('headline-only', !settings.showSummary);
els.shell.classList.toggle('ken-burns', settings.enableKenBurns);

window.addEventListener('keydown', event => {
  if (event.key === 'ArrowRight' || event.key === ' ') {
    event.preventDefault();
    nextStory();
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    previousStory();
  }
  if (event.key === 'Enter') openCurrentStory();
});

els.shell.addEventListener('click', openCurrentStory);

refreshFeeds();

function parseFeeds(raw) {
  if (!raw) return DEFAULT_FEEDS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('feeds must be a JSON array');
    const feeds = parsed.map(normalizeFeed).filter(Boolean);
    return feeds.length ? feeds : DEFAULT_FEEDS;
  } catch (error) {
    console.error('News Spotlight feed configuration failed:', error);
    return DEFAULT_FEEDS;
  }
}

function normalizeFeed(feed, index) {
  if (typeof feed === 'string') {
    return {
      id: `feed-${index + 1}`,
      name: hostName(feed),
      url: feed,
      category: 'News',
      priority: index + 1,
      enabled: true,
      includeInRotation: true,
      maxItems: 20,
      defaultImage: '',
    };
  }

  if (!feed || typeof feed !== 'object' || !feed.url) return null;
  return {
    id: cleanText(feed.id || feed.name || `feed-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || `feed-${index + 1}`,
    name: cleanText(feed.name || hostName(feed.url) || `Feed ${index + 1}`),
    url: String(feed.url || '').trim(),
    category: cleanText(feed.category || 'News'),
    priority: clampNumber(feed.priority, 1, 999, index + 1),
    enabled: feed.enabled !== false && feed.enabled !== 'false',
    includeInRotation: feed.includeInRotation !== false && feed.includeInRotation !== 'false',
    maxItems: clampNumber(feed.maxItems, 1, 50, 20),
    defaultImage: String(feed.defaultImage || '').trim(),
  };
}

async function refreshFeeds() {
  const enabled = settings.feeds.filter(feed => feed.enabled && feed.includeInRotation && feed.url);
  if (!enabled.length) {
    state.stories = [];
    state.errors = [{ sourceName: 'CONFIG', message: 'No enabled feeds configured' }];
    renderEmpty();
    scheduleRefresh();
    return;
  }

  try {
    const results = await Promise.all(enabled.map(loadFeed));
    const stories = [];
    const errors = [];
    const seen = new Set();

    results.forEach(result => {
      if (result.error) errors.push(result.error);
      result.items.forEach(item => {
        const key = item.link || item.title;
        if (!key || seen.has(key)) return;
        seen.add(key);
        stories.push(item);
      });
    });

    stories.sort((a, b) => {
      const dateDelta = timestamp(b.publishedAt) - timestamp(a.publishedAt);
      if (dateDelta) return dateDelta;
      return a.priority - b.priority;
    });

    state.lastRefreshAt = new Date();
    state.errors = errors;

    if (stories.length) {
      const current = state.stories[state.index];
      state.stories = stories;
      state.index = Math.max(0, stories.findIndex(story => current && story.id === current.id));
      if (state.index < 0) state.index = 0;
      renderStory(state.stories[state.index], false);
      startRotation();
    } else if (!state.stories.length) {
      state.stories = [];
      renderEmpty();
    }
  } catch (error) {
    console.error('News Spotlight refresh failed:', error);
    state.errors = [{ sourceName: 'RSS', message: error.message || 'Feed refresh failed' }];
    if (!state.stories.length) renderEmpty();
  } finally {
    scheduleRefresh();
  }
}

async function loadFeed(feed) {
  try {
    const response = await fetch(`/app-proxy?url=${encodeURIComponent(feed.url)}`, { cache: 'no-store' });
    const xml = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const items = parseFeedXml(xml, feed).slice(0, feed.maxItems);
    await enrichMissingImages(items);
    return { items, error: null };
  } catch (error) {
    console.error(`News Spotlight feed failed: ${feed.name}`, error);
    return {
      items: [],
      error: {
        sourceId: feed.id,
        sourceName: feed.name,
        message: error.message || 'Feed failed to load',
      },
    };
  }
}

async function enrichMissingImages(items) {
  const queue = items.filter(item => !item.image && isHttpUrl(item.link)).slice(0, 12);
  const workers = [0, 1, 2].map(async workerIndex => {
    for (let index = workerIndex; index < queue.length; index += 3) {
      const item = queue[index];
      const image = await articleImage(item.link);
      if (image) item.image = image;
    }
  });
  await Promise.all(workers);
}

async function articleImage(url) {
  try {
    const response = await fetch(`/app-proxy?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
    const html = await response.text();
    if (!response.ok) return '';
    return imageFromHtml(html, url);
  } catch (error) {
    return '';
  }
}

function parseFeedXml(xml, feed) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Invalid RSS XML');

  const rows = Array.from(doc.querySelectorAll('item'));
  const entries = rows.length ? rows : Array.from(doc.querySelectorAll('entry'));
  return entries.map((node, index) => {
    const title = cleanText(textOf(node, 'title') || 'Untitled');
    const link = linkOf(node) || textOf(node, 'guid') || feed.url;
    const description = cleanText(textOf(node, 'description') || textOf(node, 'summary') || textOf(node, 'content\\:encoded') || title);
    const publishedAt = dateOf(node);
    const image = imageOf(node) || feed.defaultImage || '';
    const category = cleanText(textOf(node, 'category') || feed.category || 'News');

    return {
      id: `${feed.id}:${hash(link || title || String(index))}`,
      sourceId: feed.id,
      sourceName: feed.name,
      category,
      priority: feed.priority,
      title,
      summary: description,
      link,
      publishedAt,
      image,
      fallbackImage: categoryBackdrop(category),
      breaking: isBreaking(`${title} ${description}`),
    };
  }).filter(item => item.title);
}

function textOf(node, selector) {
  const found = node.querySelector(selector);
  return found ? decodeHtml(found.textContent || '') : '';
}

function linkOf(node) {
  const atom = node.querySelector('link[href]');
  if (atom) return atom.getAttribute('href') || '';
  return textOf(node, 'link');
}

function dateOf(node) {
  const raw = textOf(node, 'pubDate') || textOf(node, 'published') || textOf(node, 'updated') || textOf(node, 'dc\\:date');
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function imageOf(node) {
  const selectors = [
    'media\\:content[url]',
    'media\\:thumbnail[url]',
    'enclosure[url][type^="image"]',
    'image url',
  ];

  for (const selector of selectors) {
    const found = node.querySelector(selector);
    if (!found) continue;
    const url = found.getAttribute('url') || found.textContent;
    if (isHttpUrl(url)) return url.trim();
  }

  const html = rawHtmlOf(node, 'description') || rawHtmlOf(node, 'content\\:encoded');
  return imageFromHtml(html, '');
}

function imageFromHtml(html, baseUrl) {
  const source = String(html || '');
  const metaPatterns = [
    /<meta\b[^>]*(?:property|name)=["']og:image(?::url)?["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*(?:property|name)=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image(?::url)?["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']twitter:image(?::src)?["'][^>]*>/i,
  ];

  for (const pattern of metaPatterns) {
    const match = pattern.exec(source);
    const resolved = resolveImageUrl(match && match[1], baseUrl);
    if (resolved) return resolved;
  }

  const imgMatch = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(source);
  return resolveImageUrl(imgMatch && imgMatch[1], baseUrl);
}

function resolveImageUrl(value, baseUrl) {
  const cleaned = decodeHtml(value || '').trim();
  if (!cleaned) return '';
  if (isHttpUrl(cleaned)) return cleaned;
  if (!baseUrl) return '';
  try {
    return new URL(cleaned, baseUrl).href;
  } catch (error) {
    return '';
  }
}

function renderStory(story, animate) {
  if (!story) {
    renderEmpty();
    return;
  }

  els.empty.hidden = true;
  els.headline.textContent = story.title;
  els.source.textContent = story.sourceName || 'News';
  els.category.textContent = settings.showCategory ? story.category || 'News' : '';
  els.published.textContent = settings.showPublishedTime ? formatTime(story.publishedAt) : '';
  els.summary.textContent = story.summary || story.title;
  els.counter.textContent = settings.showStoryCounter ? `Story ${state.index + 1} of ${state.stories.length}` : '';
  els.refresh.textContent = refreshLabel();
  els.breaking.hidden = !(settings.enableBreakingNews && story.breaking);
  applySourceColor(story);
  updateImage(story);
  preloadNextImage();

  if (animate) {
    els.shell.classList.add('entering');
    window.setTimeout(() => els.shell.classList.remove('entering'), 720);
  }
}

function applySourceColor(story) {
  const color = sourceColor(story.sourceName || story.sourceId || '');
  els.shell.style.setProperty('--source-accent', color);
  els.shell.style.setProperty('--source-accent-soft', alphaHex(color, 0.18));
}

function updateImage(story) {
  const current = state.activeImage === 0 ? els.imageA : els.imageB;
  const next = state.activeImage === 0 ? els.imageB : els.imageA;

  if (story.image) {
    next.removeAttribute('style');
    next.src = story.image;
    next.alt = '';
    next.onerror = () => applyFallbackImage(next, story);
  } else {
    applyFallbackImage(next, story);
  }

  next.classList.add('active');
  current.classList.remove('active');
  state.activeImage = state.activeImage === 0 ? 1 : 0;
}

function applyFallbackImage(img, story) {
  img.removeAttribute('src');
  img.onerror = null;
  img.style.background = story.fallbackImage && story.fallbackImage.startsWith('linear-gradient')
    ? story.fallbackImage
    : categoryBackdrop(story.category);
}

function startRotation() {
  clearInterval(state.rotateTimer);
  state.rotateTimer = setInterval(nextStory, settings.storyDuration * 1000);
}

function nextStory() {
  if (state.isTransitioning || state.stories.length < 2) return;
  moveStory(1);
}

function previousStory() {
  if (state.isTransitioning || state.stories.length < 2) return;
  moveStory(-1);
}

function moveStory(delta) {
  state.isTransitioning = true;
  els.shell.classList.add('exiting');
  window.setTimeout(() => {
    state.index = (state.index + delta + state.stories.length) % state.stories.length;
    els.shell.classList.remove('exiting');
    renderStory(state.stories[state.index], true);
    state.isTransitioning = false;
  }, 500);
}

async function openCurrentStory() {
  const story = state.stories[state.index];
  if (!story || !story.link) return;

  try {
    const response = await fetch(`/app-api/open?url=${encodeURIComponent(story.link)}`, { cache: 'no-store' });
    if (response.ok) return;
  } catch (error) {
  }

  window.open(story.link, '_blank', 'noopener');
}

function renderEmpty() {
  clearInterval(state.rotateTimer);
  els.empty.hidden = false;
  els.emptyStatus.textContent = emptyStatusText();
  els.headline.textContent = 'News Spotlight';
  els.source.textContent = 'Feed status';
  els.category.textContent = 'No playlist';
  els.published.textContent = state.lastRefreshAt ? formatTime(state.lastRefreshAt.toISOString()) : 'Waiting';
  els.summary.textContent = emptyStatusText();
  els.counter.textContent = 'Story 0 of 0';
  els.refresh.textContent = refreshLabel();
}

function emptyStatusText() {
  const enabled = settings.feeds.filter(feed => feed.enabled && feed.includeInRotation).length;
  const errors = state.errors.length ? `${state.errors.length} feed issue${state.errors.length === 1 ? '' : 's'}` : 'No feed errors';
  const refreshed = state.lastRefreshAt ? `Last refresh ${formatTime(state.lastRefreshAt.toISOString())}` : 'Refresh pending';
  return `${enabled} enabled feeds. ${errors}. ${refreshed}.`;
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refreshFeeds, settings.refreshIntervalMinutes * 60 * 1000);
  els.refresh.textContent = refreshLabel();
}

function preloadNextImage() {
  if (state.stories.length < 2) return;
  const next = state.stories[(state.index + 1) % state.stories.length];
  if (!next || !next.image) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = next.image;
}

function refreshLabel() {
  if (!state.lastRefreshAt) return 'Refresh pending';
  const failed = state.errors.length ? `, ${state.errors.length} issue${state.errors.length === 1 ? '' : 's'}` : '';
  return `Updated ${formatTime(state.lastRefreshAt.toISOString())}${failed}`;
}

function isBreaking(text) {
  return /\b(breaking|urgent|alert)\b/i.test(text || '');
}

function categoryBackdrop(category) {
  const key = String(category || '').toLowerCase();
  return CATEGORY_IMAGES[key] || 'linear-gradient(135deg, #10141d, #2d3746 58%, #dce4ef)';
}

function sourceColor(sourceName) {
  const text = String(sourceName || '');
  const found = SOURCE_COLORS.find(entry => entry.pattern.test(text));
  if (found) return found.color;

  let hashValue = 0;
  for (let index = 0; index < text.length; index += 1) {
    hashValue = ((hashValue << 5) - hashValue + text.charCodeAt(index)) | 0;
  }

  const palette = ['#36a3ff', '#28b487', '#d7a339', '#d96f6f', '#9a87ff', '#45c4d8'];
  return palette[Math.abs(hashValue) % palette.length];
}

function alphaHex(hex, alpha) {
  const clean = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return `rgba(94, 162, 255, ${alpha})`;
  const red = parseInt(clean.slice(0, 2), 16);
  const green = parseInt(clean.slice(2, 4), 16);
  const blue = parseInt(clean.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function cleanText(value) {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawHtmlOf(node, selector) {
  const found = node.querySelector(selector);
  return found ? found.innerHTML || found.textContent || '' : '';
}

function decodeHtml(value) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = String(value == null ? '' : value);
  return textarea.value;
}

function formatTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diffMs >= 0 && diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))} mins ago`;
  if (diffMs >= 0 && diffMs < 6 * hour) return `${Math.floor(diffMs / hour)} hour${diffMs < 2 * hour ? '' : 's'} ago`;
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return isSameDay(date, new Date()) ? `Today ${time}` : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function isSameDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function hostName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (error) {
    return 'RSS Feed';
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function readBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return value === true || value === 'true' || value === '1';
}

function timestamp(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

function hash(value) {
  let h = 5381;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}