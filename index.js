require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);
const API_BASE = 'https://www.gdebar.ru/api/v1';
const API_TOKEN = process.env.GDEBAR_API_TOKEN;

const api = axios.create({
  baseURL: API_BASE,
  headers: { Authorization: 'Bearer ' + API_TOKEN },
  timeout: 30000,
});

async function apiGet(url, params, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await api.get(url, { params }); }
    catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ─── Справочники ──────────────────────────────────────────────────────────────
let CACHE = { metros: [], kitchens: [], types: [], goodFor: [], kidOptions: [], okrugMsk: [], okrugSpb: [], metroSpb: [] };

async function fetchOne(url, timeout = 60000) {
  const resp = await api.get(url, { timeout });
  return Array.isArray(resp.data) ? resp.data : (resp.data.data || []);
}

async function loadCache() {
  console.log('Загружаю справочники...');
  const load = async (url, key, transform) => {
    for (let i = 1; i <= 5; i++) {
      try {
        const resp = await api.get(url, { timeout: 60000 });
        const data = transform ? transform(resp.data) : (Array.isArray(resp.data) ? resp.data : (resp.data.data || []));
        CACHE[key] = data;
        console.log(key + ': ' + data.length);
        return;
      } catch(e) {
        console.log(key + ' попытка ' + i + ' не удалась, жду 10 сек...');
        await new Promise(r => setTimeout(r, 10000));
      }
    }
    console.error(key + ': не удалось загрузить после 5 попыток');
  };

  await Promise.all([
    load('/metros', 'metros'),
    load('/metros?city=spb', 'metroSpb'),
    load('/kitchens', 'kitchens'),
    load('/types', 'types'),
    load('/good-for', 'goodFor'),
    load('/kid-options', 'kidOptions'),
    load('/locations?type=okrug', 'okrugMsk'),
    load('/locations?type=okrug&city=spb', 'okrugSpb'),
  ]);
  console.log('Итого:', { metros: CACHE.metros.length, kitchens: CACHE.kitchens.length, types: CACHE.types.length, goodFor: CACHE.goodFor.length });
}

// ─── Избранное (Feature 1) ────────────────────────────────────────────────────
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const FAV_FILE = path.join(DATA_DIR, 'favorites.json');

function loadFavorites() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FAV_FILE)) return {};
    return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8'));
  } catch (e) { return {}; }
}

function saveFavorites(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FAV_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Ошибка сохранения избранного:', e.message); }
}

function addFavorite(userId, bar) {
  const favs = loadFavorites();
  if (!favs[userId]) favs[userId] = [];
  if (!favs[userId].find(b => b.id === bar.id)) {
    favs[userId].unshift({ id: bar.id, name: bar.name, url: bar.url, metro: bar.metro, avg_check: bar.avg_check, savedAt: new Date().toLocaleDateString('ru-RU') });
    if (favs[userId].length > 20) favs[userId] = favs[userId].slice(0, 20);
    saveFavorites(favs);
    return true;
  }
  return false;
}

function getFavorites(userId) {
  const favs = loadFavorites();
  return favs[userId] || [];
}

function removeFavorite(userId, barId) {
  const favs = loadFavorites();
  if (favs[userId]) {
    favs[userId] = favs[userId].filter(b => b.id !== parseInt(barId));
    saveFavorites(favs);
  }
}

// ─── Подписки (Feature 4) ─────────────────────────────────────────────────────
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

function loadSubs() {
  try {
    if (!fs.existsSync(SUBS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch (e) { return {}; }
}

function saveSubs(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

function addSub(userId, label, params) {
  const subs = loadSubs();
  if (!subs[userId]) subs[userId] = [];
  subs[userId] = subs[userId].filter(s => s.label !== label);
  subs[userId].push({ label, params, createdAt: new Date().toISOString() });
  saveSubs(subs);
}

function removeSub(userId, label) {
  const subs = loadSubs();
  if (subs[userId]) { subs[userId] = subs[userId].filter(s => s.label !== label); saveSubs(subs); }
}

// ─── Статистика (Feature 5) ───────────────────────────────────────────────────
const stats = {
  users: new Set(),
  queries: [],
  metros: {},
  checks: [],
  resetDaily() { this.users = new Set(); this.queries = []; this.metros = {}; this.checks = []; }
};

function trackQuery(ctx, queryText, count, params) {
  stats.users.add(ctx.from.id);
  stats.queries.push({ name: ctx.from.first_name || 'Пользователь', text: queryText,
    time: new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }), results: count });
  if (params && params['metro[]']) {
    const m = CACHE.metros.find(x => x.id === params['metro[]']);
    const key = m ? m.name : String(params['metro[]']);
    stats.metros[key] = (stats.metros[key] || 0) + 1;
  }
  if (params && params['middleCheck[to]']) stats.checks.push(params['middleCheck[to]']);
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function parseIntent(userMessage) {
  try {
    const now = new Date();
    const moscowTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(now);
    const moscowDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: 'long', year: 'numeric' }).format(now);
    const weekdays = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
    const weekday = weekdays[new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getDay()];

    const systemPrompt = 'Ты — опытный консьерж ресторанного гида GdeBar.ru.\n'
      + 'Задача: понять что человек хочет и извлечь параметры поиска.\n\n'
      + 'КОНТЕКСТ: ' + moscowDate + ', ' + moscowTime + ' МСК, ' + weekday + '\n\n'
      + 'ЛОГИКА:\n'
      + '1. "посидеть после работы" -> opened_now=true, options:[bar_desk,cocktails]\n'
      + '2. "нас двое, атмосферно" -> good_for:романтика\n'
      + '3. "на обед" -> options:[lunch], price_to:1200\n'
      + '4. "с детьми" -> options:[kid]\n'
      + '5. "бюджетно" -> price_to:1200; "средний" -> price_to:2500; "дорогой" -> price_from:3000\n'
      + '6. МЕТРО: бери точно как написал пользователь\n'
      + '7. "в 5 минутах от метро" / "рядом с метро" -> metro_distance:500\n'
      + '8. "где поесть борщ" / "хочу стейк" -> food:["Борщ"] или food:["Стейк"]\n'
      + '9. "работает в воскресенье" -> schedule_day:7 (1=Пн..7=Вс)\n'
      + '10. "работает после 22" / "до 23" -> schedule_time:"22:00"\n'
      + '11. "нас будет 20 человек" / "большая компания" -> capacity_from:20\n'
      + '12. "со своим алкоголем" -> alco_with_self:1\n'
      + '13. "есть доставка" -> dostavka:true\n'
      + '14. "кейтеринг" -> catering:true\n'
      + '15. "недавно открылось" / "новое заведение" -> newest:true\n'
      + '16. "из сети Novikov" / "Ginza" -> chain_name:"Novikov Group"\n'
      + '17. "ближайшие" / "рядом" -> sort:"nearest"\n'
      + '18. "новые" / "недавно открылось" -> sort:"newest", newest:true\n'
      + '17. confidence: 0.9+=чёткий, 0.6-0.9=понятно, 0.3-0.6=размытый(+clarify), 0-0.3=off_topic\n\n'
      + 'ВЕРНИ ТОЛЬКО JSON (только заполненные поля):\n'
      + '{"metro_name":"...","metro_distance":500,"kitchen":"...","direction":"...","food":["..."],"type":"...","price_from":0,"price_to":0,"options":[],"good_for":"...","banket_for":"...","opened_now":true,"schedule_day":7,"schedule_time":"22:00","capacity_from":0,"capacity_to":0,"alco_with_self":1,"dostavka":true,"catering":true,"newest":true,"chain_name":"...","city":"spb","venue_name":"...","confidence":0.9,"off_topic":false,"clarify":"..."}';

    const resp = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-20250514', max_tokens: 500, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] },
      { headers: { 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' } }
    );
    return JSON.parse(resp.data.content[0].text.trim().replace(/```json|```/g, '').trim());
  } catch (e) { console.error('parseIntent:', e.message); return {}; }
}

// ─── Параметры ────────────────────────────────────────────────────────────────
function buildParams(intent) {
  const params = {};
  if (intent.venue_name) params['term'] = intent.venue_name;
  if (intent.metro_name) {
    const n = intent.metro_name.toLowerCase().trim();
    const metro = CACHE.metros.find(m => m.name.toLowerCase() === n)
      || CACHE.metros.find(m => m.name.toLowerCase().startsWith(n))
      || CACHE.metros.find(m => m.name.toLowerCase().includes(n))
      || CACHE.metros.find(m => n.includes(m.name.toLowerCase()));
    if (metro) params['metro[]'] = metro.id;
    else params['_metroNotFound'] = intent.metro_name;
  }
  if (intent.kitchen) { const k = CACHE.kitchens.find(x => x.name.toLowerCase().includes(intent.kitchen.toLowerCase())); if (k) params['kitchen[]'] = k.id; }
  if (intent.type) { const t = CACHE.types.find(x => x.name.toLowerCase().includes(intent.type.toLowerCase())); if (t) params['type[]'] = t.id; }
  if (intent.banket_for) {
    const map = { 'день рождения':1,'новый год':2,'корпоратив':3,'свадьба':4,'юбилей':4,'детский':5,'девичник':6 };
    const n = intent.banket_for.toLowerCase();
    for (const [k,v] of Object.entries(map)) { if (n.includes(k)) { params['banket[good_for][]'] = v; break; } }
  }
  if (intent.good_for) { const gf = CACHE.goodFor.find(x => x.name.toLowerCase().includes(intent.good_for.toLowerCase())); if (gf) params['good_for[]'] = gf.id; }
  // Направление кухни
  if (intent.direction) {
    const d = CACHE.kitchens.find(x => x.name.toLowerCase().includes(intent.direction.toLowerCase()));
    if (d) params['direction[]'] = d.id;
  }
  // Поиск по блюду
  if (Array.isArray(intent.food) && intent.food.length) {
    intent.food.forEach((f, i) => { params['food[' + i + ']'] = f; });
  }
  // Расстояние до метро
  if (intent.metro_distance) params['distance'] = intent.metro_distance;
  // Расписание
  if (intent.schedule_day) params['schedule[day]'] = intent.schedule_day;
  if (intent.schedule_time) params['schedule[time]'] = intent.schedule_time;
  // Вместимость
  if (intent.capacity_from) params['capacity[from]'] = intent.capacity_from;
  if (intent.capacity_to)   params['capacity[to]']   = intent.capacity_to;
  // Свой алкоголь
  if (intent.alco_with_self) params['alco_with_self[]'] = intent.alco_with_self;
  // Доставка и кейтеринг
  if (intent.dostavka) params['dostavka'] = 'on';
  if (intent.catering) params['catering'] = 'on';
  // Новые заведения
  if (intent.newest) params['newest'] = 1;
  // Сеть заведений
  if (intent.chain_name) {
    const chainMap = {
      'novikov': 87, 'новиков': 87,
      'ginza': 88, 'гинза': 88,
      'евгенич': 172775,
      'everest': 172070,
    };
    const cn = intent.chain_name.toLowerCase();
    for (const [k, v] of Object.entries(chainMap)) {
      if (cn.includes(k)) { params['chain'] = v; break; }
    }
  }
  if (intent.price_from) params['middleCheck[from]'] = intent.price_from;
  if (intent.price_to)   params['middleCheck[to]']   = intent.price_to;
  if (intent.opened_now) params['opened_now'] = 'on';
  if (intent.city === 'spb') params['city'] = 'spb';

  // Детские опции — пробуем найти конкретный подтип
  if (intent.kid_type && CACHE.kidOptions.length) {
    const kidOpt = CACHE.kidOptions.find(k => k.name.toLowerCase().includes(intent.kid_type.toLowerCase()));
    if (kidOpt) {
      params['options[kid][]'] = kidOpt.id;
    } else {
      params['options[kid]'] = 'on';
    }
  }

  if (Array.isArray(intent.options)) { for (const opt of intent.options) params['options[' + opt + ']'] = 'on'; }
  // Координаты пользователя
  if (intent.coords) {
    params['coords[]'] = intent.coords;
    params['radius'] = intent.radius || 2;
  }
  // Всегда сортируем по рейтингу
  params['sorting[rating]'] = 'desc';
  return params;
}


// ─── Часы работы ──────────────────────────────────────────────────────────────
function formatWorkingHours(schedule) {
  if (!schedule || !schedule.length) return '';
  const now = new Date();
  const moscowNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const dayOfWeek = moscowNow.getDay() || 7; // 1=Пн..7=Вс
  const hours = moscowNow.getHours();
  const minutes = moscowNow.getMinutes();
  const currentMinutes = hours * 60 + minutes;

  const today = schedule.find(s => s.day === dayOfWeek);
  if (!today || !today.open || !today.close) return '';

  const [openH, openM] = today.open.split(':').map(Number);
  const [closeH, closeM] = today.close.split(':').map(Number);
  const openMinutes  = openH * 60 + openM;
  let   closeMinutes = closeH * 60 + closeM;
  if (closeMinutes < openMinutes) closeMinutes += 24 * 60; // после полуночи

  const isOpen = currentMinutes >= openMinutes && currentMinutes < closeMinutes;

  function diffStr(diffMin) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return h > 0 ? (h + ' ч ' + (m > 0 ? m + ' мин' : '')) : m + ' мин';
  }

  if (isOpen) {
    const remaining = closeMinutes - currentMinutes;
    return '🟢 Открыто · закроется через ' + diffStr(remaining) + ' (' + today.close + ')';
  } else {
    let untilOpen = openMinutes - currentMinutes;
    if (untilOpen < 0) untilOpen += 24 * 60;
    return '🔴 Закрыто · откроется через ' + diffStr(untilOpen) + ' (' + today.open + ')';
  }
}


// ─── Контекст времени суток ───────────────────────────────────────────────────
function getMoscowHour() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getHours();
}

function getTimeGreeting() {
  const h = getMoscowHour();
  if (h >= 5  && h < 11) return { emoji: '🌅', text: 'Доброе утро' };
  if (h >= 11 && h < 17) return { emoji: '☀️', text: 'Добрый день' };
  if (h >= 17 && h < 22) return { emoji: '🌆', text: 'Добрый вечер' };
  return { emoji: '🌙', text: 'Доброй ночи' };
}

function getTimeCollections() {
  const h = getMoscowHour();
  if (h >= 5 && h < 11) return [
    { label: '☕ Лучшие завтраки', params: { 'options[lunch]': 'on', 'sorting[rating]': 'desc' } },
    { label: '🥐 Кофейня рядом',   params: { 'sorting[rating]': 'desc' }, type: 'кофейня' },
  ];
  if (h >= 11 && h < 16) return [
    { label: '🍱 Бизнес-ланч',     params: { 'options[lunch]': 'on', 'sorting[rating]': 'desc' } },
    { label: '💸 Обед до 1000 руб', params: { 'options[lunch]': 'on', 'middleCheck[to]': 1000, 'sorting[rating]': 'desc' } },
  ];
  if (h >= 16 && h < 22) return [
    { label: '🍷 Ужин вечером',    params: { 'opened_now': 'on', 'sorting[rating]': 'desc' } },
    { label: '🍻 Бар после работы', params: { 'opened_now': 'on', 'options[bar_desk]': 'on', 'sorting[rating]': 'desc' } },
  ];
  // Ночь
  return [
    { label: '🌙 Работает сейчас',  params: { 'opened_now': 'on', 'options[clock]': 'on', 'sorting[rating]': 'desc' } },
    { label: '🕺 Клуб с DJ',        params: { 'opened_now': 'on', 'options[dj]': 'on', 'options[dancefloor]': 'on', 'sorting[rating]': 'desc' } },
  ];
}

// Тематические коллекции (всегда)
const COLLECTIONS = [
  { label: '⭐ Топ Москвы',          params: { 'sorting[rating]': 'desc' } },
  { label: '🆕 Новинки',             params: { newest: 1, 'sorting[rating]': 'desc' } },
  { label: '🌿 Здоровое питание',    params: { 'options[sushi]': 'on', 'sorting[rating]': 'desc' } },
  { label: '🎭 Шоу и развлечения',   params: { 'options[show]': 'on', 'options[live_music]': 'on', 'sorting[rating]': 'desc' } },
  { label: '🍜 Азия',                params: { 'sorting[rating]': 'desc' }, kitchens: ['Японская','Китайская','Корейская','Тайская'] },
  { label: '🥩 Мясо и огонь',        params: { 'sorting[rating]': 'desc' }, type: 'стейк' },
  { label: '🍺 Крафтовое пиво',      params: { 'options[beer]': 'on', 'sorting[rating]': 'desc' } },
  { label: '🌙 Ночная Москва',       params: { 'options[clock]': 'on', 'sorting[rating]': 'desc' } },
  { label: '🐕 С собакой',           params: { 'sorting[rating]': 'desc' }, goodFor: 'собак' },
  { label: '👤 Тихое место для себя', params: { 'options[sofa]': 'on', 'sorting[rating]': 'desc' } },
  { label: '🌸 Веранды сейчас',      params: { 'options[veranda]': 'on', 'opened_now': 'on', 'sorting[rating]': 'desc' } },
  { label: '🏆 С панорамным видом',  params: { 'sorting[rating]': 'desc' }, goodFor: 'панорам' },
];

async function buildCollectionParams(col) {
  const params = { ...col.params };
  // Тип заведения
  if (col.type) {
    const t = CACHE.types.find(x => x.name.toLowerCase().includes(col.type.toLowerCase()));
    if (t) params['type[]'] = t.id;
  }
  // Кухни (массив)
  if (col.kitchens) {
    const ids = col.kitchens.map(name => {
      const k = CACHE.kitchens.find(x => x.name.toLowerCase().includes(name.toLowerCase()));
      return k ? k.id : null;
    }).filter(Boolean);
    if (ids.length) params['kitchen[]'] = ids[0]; // берём первую для простоты
  }
  // good_for
  if (col.goodFor) {
    const gf = CACHE.goodFor.find(x => x.name.toLowerCase().includes(col.goodFor.toLowerCase()));
    if (gf) params['good_for[]'] = gf.id;
  }
  return params;
}


// Детали опции заведения через отдельный эндпоинт
async function getBarFeatures(barId) {
  try {
    const resp = await api.get('/bar/' + barId + '/features', { timeout: 15000 });
    return resp.data || null;
  } catch(e) { return null; }
}

function formatFeatureDetails(features, type) {
  if (!features || !features[type]) return '';
  const d = features[type];
  const lines = [];
  if (type === 'hookah' && d.items && d.items.length)
    lines.push('Кальяны: ' + d.items.slice(0,3).map(i => i.name + (i.price ? ' ' + i.price + '₽' : '')).join(', '));
  if (type === 'veranda') {
    if (d.type) lines.push('Тип: ' + d.type);
    if (d.conveniences && d.conveniences.length) lines.push('Удобства: ' + d.conveniences.slice(0,3).join(', '));
  }
  if (type === 'live_music') {
    if (d.directions && d.directions.length) lines.push('Стиль: ' + d.directions.slice(0,3).join(', '));
    if (d.instruments && d.instruments.length) lines.push('Инструменты: ' + d.instruments.slice(0,3).join(', '));
  }
  if (type === 'lunch') {
    if (d.price_from && d.price_to) lines.push('Цена: ' + d.price_from + '–' + d.price_to + '₽');
    if (d.schedule) lines.push('Время: ' + d.schedule);
  }
  if (type === 'parking') {
    if (d.type) lines.push('Тип: ' + d.type);
    if (d.payment === 0) lines.push('Бесплатная');
    else if (d.payment) lines.push('Платная');
  }
  if (type === 'karaoke' && d.rooms) lines.push('Залов: ' + d.rooms.length);
  return lines.join(' · ');
}

// ─── Форматирование ───────────────────────────────────────────────────────────
function formatBar(bar, index) {
  const stars = bar.rating >= 9 ? '🌟' : bar.rating >= 7 ? '⭐' : '✨';
  const rating  = bar.rating   ? stars + ' *' + bar.rating + '* (' + bar.reviews_count + ' отз.)' : '';
  const check   = bar.avg_check ? '💰 ' + bar.avg_check + ' руб.' : '';
  const metro   = bar.metro    ? '🚇 ' + bar.metro + (bar.metro_distance_m ? ' · ' + bar.metro_distance_m + ' м' : '') : '';
  const cuisine = bar.cuisine && bar.cuisine.length ? '🍽 ' + bar.cuisine.slice(0, 3).join(', ') : '';
  const address = bar.address  ? '📍 ' + bar.address : '';
  const desc    = bar.description ? '❝ ' + bar.description.trim() + ' ❞' : '';
  const features = bar.features && bar.features.length ? '✨ ' + bar.features.slice(0, 4).join(' · ') : '';
  const hours   = bar.schedule ? formatWorkingHours(bar.schedule) : '';
  const phone   = bar.phone   ? '📞 [' + bar.phone + '](tel:' + bar.phone.replace(/[^+\d]/g, '') + ')' : '';

  const lines = [
    '┌ *' + index + '. ' + bar.name + '*',
    [rating, check].filter(Boolean).map(s => '├ ' + s).join('\n'),
    [metro, address].filter(Boolean).map(s => '├ ' + s).join('\n'),
    cuisine ? '├ ' + cuisine : '',
    desc    ? '├ ' + desc    : '',
    hours   ? '├ ' + hours   : '',
    features ? '├ ' + features : '',
    hours   ? '├ ' + hours   : '',
    phone   ? '└ ' + phone   : '',
  ].filter(Boolean);

  return lines.join('\n');
}

function cleanUrl(url) { return url ? url.split('?')[0] : ''; }

function barInlineKeyboard(bar) {
  const base = cleanUrl(bar.url);
  const row1 = [];
  const row2 = [];

  // Ссылка на сайт — всегда если есть url
  if (bar.url) row1.push(Markup.button.url('🌐 На сайте', bar.url));

  // Меню — показываем только если есть поле has_menu или всегда (пока Макс не добавит флаг)
  if (base && bar.has_menu) {
    row1.push(Markup.button.url('🍽 Меню', base + '/menu'));
  }

  // Отзывы — только если reviews_count > 0
  if (base && bar.reviews_count > 0) {
    row2.push(Markup.button.url('💬 Отзывы (' + bar.reviews_count + ')', base + '/otzyvy'));
  }

  // Карта — название + адрес для точного попадания
  if (bar.address || bar.name) {
    const query = encodeURIComponent((bar.name ? bar.name + ' ' : '') + (bar.address || ''));
    row2.push(Markup.button.url('🗺 На карте', 'https://yandex.ru/maps/?text=' + query));
  }

  // Избранное — всегда
  row2.push(Markup.button.callback('❤️ В избранное', 'fav_' + bar.id));



  // Собираем только непустые строки
  const rows = [row1, row2].filter(r => r.length > 0);
  return Markup.inlineKeyboard(rows);
}

function hasValidPhoto(url) { return url && url.startsWith('http') && !url.includes('placeholder') && !url.includes('localhost'); }

// ─── Состояние ────────────────────────────────────────────────────────────────
const sessions = {};
const wizards  = {};
const barCache = {}; // id -> bar object для похожих и избранного

// ─── Сообщения ────────────────────────────────────────────────────────────────
const MSG1 = ['🔍 Сейчас поищем что-нибудь подходящее...', '🔍 Просматриваю заведения по вашему запросу...', '🔍 Уже ищу — сейчас найдём...'];
const MSG2 = ['✨ Нашлось несколько вариантов, формирую...', '✨ Хорошие заведения попались, сейчас покажу...', '✨ Собираю карточки — ещё секунду...'];
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Wizard ───────────────────────────────────────────────────────────────────
async function runWizard(ctx, userId) {
  const w = wizards[userId];
  if (!w) return;
  if (w.step === 0) {
    await ctx.reply('Давайте подберём вместе!\n\nЧто важнее всего в этот раз?',
      Markup.keyboard([['🍻 Выпить в баре или пабе'],['🤫 Спокойно поговорить'],['🎤 Спеть в караоке'],['🕺 Потанцевать'],['🎸 Живая музыка'],['👶 Пойти с детьми'],['💼 Деловая встреча'],['🍽 Вкусно поесть'],['🌿 С верандой'],['❌ Отмена']]).resize());
  } else if (w.step === 1) {
    const occ = w.answers.occasion || '';
    let q = 'Какой примерно бюджет на человека?';
    if (occ.includes('детьми')) q = 'С детьми — главное чтоб было комфортно 👶\n\nКакой бюджет на человека?';
    else if (occ.includes('Деловая')) q = 'Деловой формат — важна атмосфера.\n\nКакой бюджет на человека?';
    await ctx.reply(q, Markup.keyboard([['до 1 000 руб.'],['1 000 – 1 500 руб.'],['1 500 – 2 000 руб.'],['2 000 – 3 000 руб.'],['от 3 000 руб.'],['Не важно'],['❌ Отмена']]).resize());
  } else if (w.step === 2) {
    // Если локация уже задана — пропускаем
    if (w.skipLocation) { w.step = 3; return await runWizard(ctx, userId); }

    const isSpb = sessions[userId]?.selectedCity === 'spb';
    const metroHint = isSpb ? 'Введите станцию метро Петербурга...' : 'Введите станцию метро Москвы...';

    let districtKeyboard;
    if (isSpb) {
      // Питерские районы — берём из кэша или хардкодим основные
      const spbDistricts = CACHE.okrugSpb.length
        ? CACHE.okrugSpb.slice(0, 9).map(d => d.name)
        : ['Центральный','Василеостровский','Адмиралтейский','Петроградский','Невский','Московский','Приморский','Выборгский','Красногвардейский'];
      const rows = [];
      for (let i = 0; i < spbDistricts.length; i += 3) rows.push(spbDistricts.slice(i, i+3));
      rows.push(['Не важно'], ['❌ Отмена']);
      districtKeyboard = Markup.keyboard(rows).resize();
    } else {
      districtKeyboard = Markup.keyboard([['ЦАО','ЗАО','САО'],['ЮЗАО','ЮАО','СВАО'],['ВАО','ЮВАО','СЗАО'],['Не важно'],['❌ Отмена']]).resize();
    }
    await ctx.reply('Почти готово!\n\nВ каком районе ищем? Выберите район или напишите метро:', districtKeyboard);
  } else {
    delete wizards[userId];
    const { occasion, budget, location } = w.answers;
    const okrugMap = { 'ЦАО':11,'ЗАО':38,'САО':31,'ЮЗАО':3,'ЮАО':34,'СВАО':8,'ВАО':77,'ЮВАО':82,'СЗАО':28 };

    // Строим параметры: preParams (из кнопки) + бюджет + локация
    const params = Object.assign({}, w.preParams || {});

    // Город из сессии
    const isSpb = sessions[userId]?.selectedCity === 'spb';
    if (isSpb) params['city'] = 'spb';

    // Округ / район
    const metroList = isSpb ? CACHE.metroSpb : CACHE.metros;
    const okrugList = isSpb ? CACHE.okrugSpb : CACHE.okrugMsk;

    if (location && !['Не важно','❌ Отмена'].includes(location)) {
      // Ищем в округах
      if (okrugMap[location]) {
        params['location[okrug][]'] = okrugMap[location];
      } else {
        const okrug = okrugList.find(o => o.name.toLowerCase().includes(location.toLowerCase()));
        if (okrug) {
          params['location[okrug][]'] = okrug.id;
        } else {
          // Ищем в метро
          const n = location.toLowerCase().trim();
          const metro = metroList.find(m => m.name.toLowerCase() === n)
            || metroList.find(m => m.name.toLowerCase().startsWith(n))
            || metroList.find(m => m.name.toLowerCase().includes(n));
          if (metro) params['metro[]'] = metro.id;
        }
      }
    }

    // Бюджет
    const budgetMap = {
      'до 1 000 руб.': { to: 1000 },
      '1 000 – 1 500 руб.': { from: 1000, to: 1500 },
      '1 500 – 2 000 руб.': { from: 1500, to: 2000 },
      '2 000 – 3 000 руб.': { from: 2000, to: 3000 },
      'от 3 000 руб.': { from: 3000 },
    };
    if (budget && budgetMap[budget]) {
      if (budgetMap[budget].from) params['middleCheck[from]'] = budgetMap[budget].from;
      if (budgetMap[budget].to)   params['middleCheck[to]']   = budgetMap[budget].to;
    }

    const query = [occasion, budget, location].filter(x => x && !['Не важно','❌ Отмена'].includes(x)).join(', ');
    console.log('Wizard params:', JSON.stringify(params));
    sessions[userId] = { params, page: 1, lastQuery: query };
    await ctx.reply('Ищу для вас — ' + query + ' 🔍');
    await showResults(ctx, userId);
  }
}

// ─── Популярные подборки ──────────────────────────────────────────────────────
// Каждая кнопка: { label, params, skipLocation, skipBudget }
const POPULAR_CONFIG = [
  { label: '👫 Пойти с друзьями',      params: {},                                    skipLocation: false, skipBudget: false },
  { label: '🚶 Посидеть в центре',      params: { 'location[okrug][]': 11 },           skipLocation: true,  skipBudget: false },
  { label: '🍷 Романтический ужин',     params: { 'good_for[]': 30 },                  skipLocation: false, skipBudget: false },
  { label: '👶 С детьми',               params: { 'options[kid]': 'on' },              skipLocation: false, skipBudget: false },
  { label: '💼 Деловая встреча',        params: { 'options[lunch]': 'on' },            skipLocation: false, skipBudget: false },
  { label: '🍻 Выпить после работы',    params: { 'options[beer]': 'on', 'options[bar_desk]': 'on' }, skipLocation: false, skipBudget: false },
  { label: '🎤 Попеть в караоке',       params: { 'options[karaoke]': 'on' },          skipLocation: false, skipBudget: false },
  { label: '🌿 С верандой',             params: { 'options[veranda]': 'on' },          skipLocation: false, skipBudget: false },
  { label: '🎸 Живая музыка',           params: { 'options[live_music]': 'on' },       skipLocation: false, skipBudget: false },
  { label: '🕺 Потанцевать',            params: { 'options[dancefloor]': 'on', 'options[dj]': 'on' }, skipLocation: false, skipBudget: false },
];
const POPULAR = POPULAR_CONFIG.map(p => p.label);

function mainKeyboard() {
  const timeCols = getTimeCollections();
  return Markup.keyboard([
    ...POPULAR.map(p => [p]),
    timeCols.map(c => c.label),
    ['📍 Рядом со мной', '🟢 Открыто сейчас'],
    ['🗂 Подборки', '🤔 Задай мне 5 вопросов'],
    ['📋 Мои подписки', '❤️ Избранное'],
    ['🔄 Новый поиск'],
  ]).resize();
}

// ─── Показ результатов ────────────────────────────────────────────────────────
async function showResults(ctx, userId) {
  const session = sessions[userId];
  if (!session) return;
  const isFirst = session.page === 1;

  if (isFirst) { await ctx.reply(rnd(MSG1)); await ctx.sendChatAction('typing'); }

  let response;
  try {
    const [resp] = await Promise.all([
      apiGet('/search', { ...session.params, page: session.page, per_page: 6 }),
      isFirst ? sleep(3000) : Promise.resolve(),
    ]);
    response = resp;
  } catch(e) {
    const timeoutMsgs = [
      'Упс... похоже наш сервер решил немного вздремнуть 😴 Попробуйте через минуту!',
      'Сервер завис — видимо тоже ищет где поужинать 🍽 Повторите запрос чуть позже.',
      'Что-то у нас сервер задумался... Он не злой, просто медленный 🐢 Попробуйте ещё раз!',
      'База данных взяла кофе-брейк ☕ Обычно это ненадолго — попробуйте через 30 секунд.',
    ];
    await ctx.reply(timeoutMsgs[Math.floor(Math.random() * timeoutMsgs.length)],
      Markup.keyboard([['🔄 Попробовать снова'], ['🔄 Новый поиск']]).resize());
    return;
  }

  const allBars = response.data.data || [];
  const meta    = response.data.meta || {};
  const total   = meta.total || 0;
  const lastPage = meta.last_page || 1;

  if (allBars.length === 0) {
    const relaxed = { ...session.params };
    let msg = '';
    if (relaxed['middleCheck[to]']) { delete relaxed['middleCheck[to]']; delete relaxed['middleCheck[from]']; msg = 'расширяю бюджет'; }
    else if (relaxed['metro[]']) { delete relaxed['metro[]']; msg = 'расширяю до всего района'; }
    else if (relaxed['kitchen[]']) { delete relaxed['kitchen[]']; msg = 'убираю фильтр по кухне'; }
    if (msg) {
      const retry = await apiGet('/search', { ...relaxed, page: 1, per_page: 6 });
      const retryBars = retry.data.data || [];
      if (retryBars.length > 0) {
        await ctx.reply('По точному запросу не нашлось — ' + msg + ' 🔍');
        session.params = relaxed;
        const sorted2 = [...retryBars.filter(b=>b.phone), ...retryBars.filter(b=>!b.phone)].slice(0, 3);
        if (isFirst) { trackQuery(ctx, session.lastQuery||'', sorted2.length, relaxed); await ctx.reply(rnd(MSG2)); await ctx.sendChatAction('typing'); await sleep(2000); }
        for (let i = 0; i < sorted2.length; i++) {
          const bar = sorted2[i]; barCache[bar.id] = bar;
          const text = formatBar(bar, i+1); const kb = barInlineKeyboard(bar);
          if (hasValidPhoto(bar.photo_url)) { try { await ctx.replyWithPhoto(bar.photo_url, { caption: text, parse_mode: 'Markdown', ...kb }); continue; } catch(e) {} }
          await ctx.replyWithMarkdown(text, { disable_web_page_preview: true, ...kb });
        }
        await ctx.reply('Нашлось ' + (retry.data.meta?.total||0) + ' заведений с расширенными параметрами.',
          Markup.keyboard([['📄 Показать ещё'],['💸 Подешевле','💎 Подороже'],['🔄 Новый поиск']]).resize());
        return;
      }
    }
    // Предлагаем 3 популярные подборки вместо тупика
    const fallbackCols = [
      { label: '⭐ Топ Москвы — лучшие по рейтингу', params: { 'sorting[rating]': 'desc' } },
      { label: '🌿 Открытые веранды прямо сейчас',   params: { 'options[veranda]': 'on', 'opened_now': 'on', 'sorting[rating]': 'desc' } },
      { label: '💰 Хорошие места до 1500 руб.',      params: { 'middleCheck[to]': 1500, 'sorting[rating]': 'desc' } },
    ];

    await ctx.reply(
      'Хм, по таким параметрам пока ничего не нашлось 🤷\n\n' +
      'Но не расстраивайтесь — вот три подборки, которые нравятся большинству:'
    );

    for (const col of fallbackCols) {
      try {
        const resp = await apiGet('/search', { ...col.params, page: 1, per_page: 1 });
        const total = resp.data.meta?.total || 0;
        if (total > 0) {
          await ctx.reply(col.label + '  (' + total + ' заведений)',
            Markup.inlineKeyboard([[Markup.button.callback('Показать →', 'col_' + encodeURIComponent(col.label))]]));
        }
      } catch(e) {
        await ctx.reply(col.label, Markup.inlineKeyboard([[Markup.button.callback('Показать →', 'col_' + encodeURIComponent(col.label))]]));
      }
    }

    await ctx.reply('Или попробуйте изменить запрос 👇',
      Markup.keyboard([['🤔 Задай мне 5 вопросов'], ['🔄 Новый поиск']]).resize());
    return;
  }

  // Пост-фильтр: убираем заведения не из того города/округа
  let filteredBars = allBars;

  // Если искали по округу — проверяем что заведение действительно из Москвы
  if (session.params['location[okrug][]']) {
    filteredBars = allBars.filter(b => {
      // Исключаем если явно другой город (область)
      if (b.location && b.location.city) {
        const city = b.location.city.toLowerCase();
        if (city.includes('петербург') || city.includes('мурино') || city.includes('всеволож')) return false;
      }
      if (b.url && b.url.includes('/spb/')) return false;
      return true;
    });
    if (filteredBars.length === 0) filteredBars = allBars; // откат если всё отфильтровали
  }

  // Если искали Москву (нет city=spb) — убираем питерские заведения
  if (!session.params['city']) {
    filteredBars = filteredBars.filter(b => b.url ? !b.url.includes('/spb/') : true);
    if (filteredBars.length === 0) filteredBars = allBars;
  }

  const sorted = [...filteredBars.filter(b=>b.phone), ...filteredBars.filter(b=>!b.phone)].slice(0, 3);
  if (isFirst) { trackQuery(ctx, session.lastQuery||'', sorted.length, session.params); await ctx.reply(rnd(MSG2)); await ctx.sendChatAction('typing'); await sleep(2500); }

  const offset = (session.page - 1) * 3;
  for (let i = 0; i < sorted.length; i++) {
    const bar = sorted[i]; barCache[bar.id] = bar;
    const text = formatBar(bar, offset+i+1);
    try {
      const kb = barInlineKeyboard(bar);
      if (hasValidPhoto(bar.photo_url)) {
        try { await ctx.replyWithPhoto(bar.photo_url, { caption: text, parse_mode: 'Markdown', ...kb }); continue; } catch(e) {}
      }
      await ctx.replyWithMarkdown(text, { disable_web_page_preview: true, ...kb });
    } catch(e) {
      // fallback без инлайн кнопок если 400
      if (hasValidPhoto(bar.photo_url)) {
        try { await ctx.replyWithPhoto(bar.photo_url, { caption: text, parse_mode: 'Markdown' }); continue; } catch(e2) {}
      }
      await ctx.replyWithMarkdown(text, { disable_web_page_preview: true });
    }
  }

  const hasMore = session.page < lastPage;
  const outroText = total > 10 ? 'Нашлось ' + total + ' заведений — вот топ по рейтингу 👆' : 'Вот что подобрал по вашему запросу 👆';

  await ctx.reply(outroText,
    Markup.keyboard([
      hasMore ? ['📄 Показать ещё'] : [],
      ['💸 Подешевле', '💎 Подороже'],
      ['📍 Ближе к центру'],
      ['🔄 Новый поиск'],
    ].filter(r => r.length > 0)).resize()
  );

  // Кнопка — открыть именно эту подборку на сайте
  const barIds = sorted.map(b => b.id).filter(Boolean);
  if (barIds.length > 0) {
    const collectionUrl = 'https://www.gdebar.ru/bars?' + barIds.map(id => 'barIds[]=' + id).join('&') + '&utm_campaign=tg_bot_ai';
    await ctx.reply(
      'Смотрите эти заведения на сайте — там полное меню, фото и форма бронирования:',
      Markup.inlineKeyboard([[
        Markup.button.url('Открыть подборку на GdeBar.ru ↗', collectionUrl)
      ]])
    );
  }

}

// ─── Команды ──────────────────────────────────────────────────────────────────
bot.start(async ctx => {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (adminId) {
    const u = ctx.from;
    bot.telegram.sendMessage(adminId,
      '🆕 *Новый пользователь*\n👤 ' + [u.first_name, u.last_name].filter(Boolean).join(' ') +
      '\n🔗 ' + (u.username ? '@'+u.username : 'нет') + '\n🆔 `' + u.id + '`\n🕐 ' +
      new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
      { parse_mode: 'Markdown' }).catch(()=>{});
  }
  const { emoji, text } = getTimeGreeting();
  await ctx.reply(
    emoji + ' ' + text + '! 👋\n\n' +
    'Я помогаю находить рестораны, кафе и бары в Москве и Санкт-Петербурге.\n\n' +
    'Умею подбирать по:\n' +
    '• Станции метро или округу\n' +
    '• Типу кухни (грузинская, японская, итальянская...)\n' +
    '• Бюджету на человека\n' +
    '• Особенностям (кальян, веранда, живая музыка, дети, DJ...)\n\n' +
    'С какого города начнём?',
    Markup.keyboard([['🏙 Москва', '🌊 Санкт-Петербург']]).resize()
  );
});

bot.help(ctx => ctx.reply('Напишите что ищете или выберите подборку.\nМожно указать: метро, кухню, бюджет, особенности.'));

// /favorites
bot.command('favorites', async ctx => {
  const favs = getFavorites(ctx.from.id);
  if (!favs.length) return ctx.reply('У вас пока нет сохранённых заведений.\n\nНажимайте ❤️ под карточками — они появятся здесь.');
  let text = '❤️ *Ваше избранное:*\n\n';
  favs.forEach((b, i) => {
    text += (i+1) + '. *' + b.name + '*\n';
    if (b.metro) text += '🚇 ' + b.metro + '\n';
    if (b.avg_check) text += '💰 ' + b.avg_check + ' руб.\n';
    if (b.url) text += '[Открыть на сайте](' + b.url + ')\n';
    text += '\n';
  });
  await ctx.replyWithMarkdown(text, { disable_web_page_preview: true });
});

// /subscribe
bot.command('subscribe', async ctx => {
  const subs = loadSubs();
  const userSubs = subs[ctx.from.id] || [];
  if (!userSubs.length) {
    return ctx.reply('У вас нет активных подписок.\n\nПосле поиска нажмите «📬 Подписаться на новинки» — будете получать новые заведения раз в неделю.');
  }
  const text = '📬 *Ваши подписки:*\n\n' + userSubs.map((s,i) => (i+1) + '. ' + s.label).join('\n');
  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(
    userSubs.map((s,i) => [Markup.button.callback('❌ ' + s.label.slice(0,25), 'unsub_' + i)])
  ));
});

// /report
bot.command('report', async ctx => {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (String(ctx.from.id) !== String(adminId)) return ctx.reply('Нет доступа.');
  const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
  if (stats.queries.length === 0) return ctx.reply('За сегодня (' + date + ') запросов пока не было.');

  const topMetros = Object.entries(stats.metros).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>k+': '+v).join(', ') || 'нет данных';
  const avgCheck = stats.checks.length ? Math.round(stats.checks.reduce((a,b)=>a+b,0)/stats.checks.length) : 0;
  const queryCount = {};
  stats.queries.forEach(q => { const k = q.text.toLowerCase().slice(0,30); queryCount[k] = (queryCount[k]||0)+1; });
  const topQueries = Object.entries(queryCount).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>v>1?k+' (x'+v+')':k).join('\n') || 'нет';

  const list = stats.queries.map((q,i)=>(i+1)+'. ['+q.time+'] '+q.name+': '+q.text+' - '+q.results+' рез.').join('\n');
  const report = 'Отчет за ' + date + '\n\nПользователей: ' + stats.users.size + '\nЗапросов: ' + stats.queries.length + '\n\nТоп метро: ' + topMetros + '\nСредний запрашиваемый чек: ' + (avgCheck||'—') + ' руб.\n\nТоп запросы:\n' + topQueries + '\n\nВсе запросы:\n' + list;
  await ctx.reply(report.length > 4000 ? report.substring(0, 3900) + '\n...' : report);
});

// ─── Callback кнопки ──────────────────────────────────────────────────────────

// Избранное — добавить
bot.action(/^fav_(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const barId = parseInt(ctx.match[1]);
  const bar = barCache[barId];
  if (!bar) return ctx.answerCbQuery('Не удалось найти заведение');
  const added = addFavorite(ctx.from.id, bar);
  await ctx.reply(added ? '❤️ Добавлено в избранное: *' + bar.name + '*\n\nСмотреть: /favorites' : 'Уже есть в избранном.', { parse_mode: 'Markdown' });
});

// Похожие заведения
bot.action(/^similar_(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const barId = parseInt(ctx.match[1]);
  const bar = barCache[barId];
  if (!bar) return ctx.reply('Не удалось найти данные о заведении.');
  const params = {};
  if (bar.cuisine && bar.cuisine.length) {
    const k = CACHE.kitchens.find(x => x.name === bar.cuisine[0]);
    if (k) params['kitchen[]'] = k.id;
  }
  if (bar.metro) {
    const m = CACHE.metros.find(x => x.name === bar.metro);
    if (m) params['metro[]'] = m.id;
  }
  await ctx.reply('Ищу похожие заведения...');
  try {
    const resp = await apiGet('/search', { ...params, page: 1, per_page: 6 });
    const bars = (resp.data.data || []).filter(b => b.id !== barId).slice(0, 3);
    if (!bars.length) return ctx.reply('Похожих заведений рядом не нашлось.');
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]; barCache[b.id] = b;
      const text = formatBar(b, i+1); const kb = barInlineKeyboard(b);
      if (hasValidPhoto(b.photo_url)) { try { await ctx.replyWithPhoto(b.photo_url, { caption: text, parse_mode: 'Markdown', ...kb }); continue; } catch(e) {} }
      await ctx.replyWithMarkdown(text, { disable_web_page_preview: true, ...kb });
    }
  } catch(e) { ctx.reply('Ошибка при поиске похожих.'); }
});

// Отписка
bot.action(/^unsub_(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const idx = parseInt(ctx.match[1]);
  const subs = loadSubs();
  const userSubs = subs[ctx.from.id] || [];
  if (userSubs[idx]) {
    const label = userSubs[idx].label;
    removeSub(ctx.from.id, label);
    await ctx.reply('Отписались от: ' + label);
  }
});


// Детали опции — callback
bot.action(/^feat_(\d+)_(.+)$/, async ctx => {
  await ctx.answerCbQuery('Загружаю...');
  const barId = ctx.match[1];
  const featType = ctx.match[2];
  const features = await getBarFeatures(barId);
  if (!features) return ctx.reply('Детали недоступны. Смотрите на сайте заведения.');
  const detail = formatFeatureDetails(features, featType);
  const bar = barCache[parseInt(barId)];
  const name = bar ? bar.name : 'Заведение';
  await ctx.reply(detail ? name + '\n\n' + detail : 'Подробная информация на сайте заведения.');
});

// Быстрые коллекции из заглушек
const QUICK_COLS = {
  'col_top':     { params: { 'sorting[rating]': 'desc' } },
  'col_open':    { params: { 'opened_now': 'on', 'sorting[rating]': 'desc' } },
  'col_veranda': { params: { 'options[veranda]': 'on', 'opened_now': 'on', 'sorting[rating]': 'desc' } },
  'col_budget':  { params: { 'middleCheck[to]': 1500, 'sorting[rating]': 'desc' } },
};

bot.action(/^col_(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const key = ctx.match[1];
  const userId = ctx.from.id;

  // Сначала проверяем быстрые коллекции по ключу
  if (QUICK_COLS[key]) {
    sessions[userId] = { params: { ...QUICK_COLS[key].params }, page: 1, lastQuery: key };
    return await showResults(ctx, userId);
  }

  // Потом ищем по label в COLLECTIONS
  const label = decodeURIComponent(key);
  const col = COLLECTIONS.find(c => c.label === label) || getTimeCollections().find(c => c.label === label);
  if (col) {
    const params = await buildCollectionParams(col);
    sessions[userId] = { params, page: 1, lastQuery: label };
    return await showResults(ctx, userId);
  }

  await ctx.reply('Не удалось загрузить подборку. Попробуйте ещё раз.');
});

// Геолокация
bot.on('location', async ctx => {
  const userId = ctx.from.id;
  const { latitude, longitude } = ctx.message.location;
  await ctx.reply('📍 Нашёл вашу геолокацию, ищу заведения рядом...');
  sessions[userId] = {
    params: { 'coords[]': [latitude, longitude], radius: 2, 'sorting[rating]': 'desc' },
    page: 1, lastQuery: 'рядом со мной'
  };
  await showResults(ctx, userId);
});

// ─── Основной обработчик ──────────────────────────────────────────────────────
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const text   = ctx.message.text;

  // Выбор города
  if (text === '🏙 Москва' || text === '🌊 Санкт-Петербург') {
    const city = text === '🌊 Санкт-Петербург' ? 'spb' : 'msk';
    // Явно фиксируем город в сессии — для Москвы НЕ передаём city (по умолчанию Москва)
    sessions[userId] = { params: city === 'spb' ? { city: 'spb' } : {}, page: 1, lastQuery: '', city };
    // Сохраняем выбранный город в сессии пользователя
    sessions[userId].selectedCity = city;
    await ctx.reply('Отлично, ищем в ' + (city === 'spb' ? 'Петербурге' : 'Москве') + '! 🗺\n\nКуда хотите пойти? Напишите своими словами — или выберите из популярного:\n\n• Куда пойти с друзьями вечером\n• Погулять и зайти куда-нибудь в центре\n• Хочу что-то вкусное рядом с домом\n• Просто посидеть в хорошем месте\n• Куда сходить на выходных', mainKeyboard());
    return;
  }

  // Новые заведения
  if (text === '🆕 Новые заведения') {
    const base = sessions[userId]?.params || {};
    sessions[userId] = { params: { ...base, newest: 1, sort: 'newest' }, page: 1, lastQuery: 'новые заведения' };
    return await showResults(ctx, userId);
  }

  // Подборки — показываем меню коллекций
  if (text === '🗂 Подборки') {
    const timeCols = getTimeCollections();
    const allCols = [...timeCols, ...COLLECTIONS];
    const keyboard = allCols.map(c => [c.label]);
    keyboard.push(['🔙 Назад']);
    await ctx.reply(
      '🗂 *Тематические подборки*\n\nВыберите что вас интересует:',
      { parse_mode: 'Markdown', reply_markup: Markup.keyboard(keyboard).resize().reply_markup }
    );
    return;
  }

  if (text === '🔙 Назад') {
    return ctx.reply('Что ищете?', mainKeyboard());
  }

  // Обработка нажатия на коллекцию
  const timeCols = getTimeCollections();
  const allCols = [...timeCols, ...COLLECTIONS];
  const matchedCol = allCols.find(c => c.label === text);
  if (matchedCol) {
    const params = await buildCollectionParams(matchedCol);
    sessions[userId] = { params, page: 1, lastQuery: matchedCol.label };
    return await showResults(ctx, userId);
  }

  // Кнопка "Рядом со мной" - запрашиваем геолокацию
  if (text === '📍 Рядом со мной') {
    return ctx.reply(
      'Поделитесь геолокацией — найду заведения рядом с вами 📍',
      Markup.keyboard([[Markup.button.locationRequest('📍 Отправить моё местоположение')], ['❌ Отмена']]).resize()
    );
  }

  // Геолокация
  if (ctx.message?.location) {
    const { latitude, longitude } = ctx.message.location;
    sessions[userId] = {
      params: { 'coords[]': [latitude, longitude], radius: 2, 'sorting[rating]': 'desc' },
      page: 1, lastQuery: 'рядом со мной'
    };
    return await showResults(ctx, userId);
  }

  // Открыто сейчас (Feature 2)
  if (text === '🟢 Открыто сейчас') {
    const base = sessions[userId]?.params || {};
    sessions[userId] = { params: { ...base, opened_now: 'on' }, page: 1, lastQuery: 'открыто сейчас' };
    return await showResults(ctx, userId);
  }

  // Избранное
  if (text === '❤️ Избранное') {
    return ctx.reply('Смотреть избранное: /favorites');
  }

  // Подписки
  if (text === '📋 Мои подписки') {
    return ctx.reply('Смотреть подписки: /subscribe');
  }

  // Уточнение после результатов (Feature 3)
  if (text === '💸 Подешевле' && sessions[userId]) {
    const p = { ...sessions[userId].params };
    const curMax = p['middleCheck[to]'] || 3000;
    p['middleCheck[to]'] = Math.round(curMax * 0.7);
    delete p['middleCheck[from]'];
    sessions[userId] = { ...sessions[userId], params: p, page: 1 };
    await ctx.reply('Ищу подешевле — до ' + p['middleCheck[to]'] + ' руб. 🔍');
    return await showResults(ctx, userId);
  }

  if (text === '💎 Подороже' && sessions[userId]) {
    const p = { ...sessions[userId].params };
    const curMax = p['middleCheck[to]'] || 2000;
    p['middleCheck[from]'] = curMax;
    delete p['middleCheck[to]'];
    sessions[userId] = { ...sessions[userId], params: p, page: 1 };
    await ctx.reply('Ищу подороже — от ' + p['middleCheck[from]'] + ' руб. 🔍');
    return await showResults(ctx, userId);
  }

  if (text === '📍 Ближе к центру' && sessions[userId]) {
    const p = { ...sessions[userId].params };
    delete p['metro[]'];
    p['location[okrug][]'] = 11; // ЦАО
    sessions[userId] = { ...sessions[userId], params: p, page: 1 };
    await ctx.reply('Ищу в центре (ЦАО) 🗺');
    return await showResults(ctx, userId);
  }

  // Ответ на clarify
  if (sessions[userId]?.pendingClarify && !wizards[userId] && text !== '🔄 Новый поиск' && text !== '❌ Отмена') {
    const combined = sessions[userId].lastQuery + '. ' + text;
    delete sessions[userId].pendingClarify;
    await ctx.sendChatAction('typing');
    try {
      const intent = await parseIntent(combined);
      sessions[userId] = { params: buildParams(intent), page: 1, lastQuery: combined };
      return await showResults(ctx, userId);
    } catch(e) { return ctx.reply('Что-то пошло не так. Попробуйте ещё раз.'); }
  }

  // Отмена
  if (text === '❌ Отмена') {
    delete wizards[userId]; delete sessions[userId];
    return ctx.reply('Хорошо, отменили. Что ищете?', mainKeyboard());
  }

  // Wizard
  if (wizards[userId]) {
    const stepKeys = ['occasion','budget','location'];
    wizards[userId].answers[stepKeys[wizards[userId].step]] = text;
    wizards[userId].step++;
    return await runWizard(ctx, userId);
  }

  if (text === '🤔 Задай мне 5 вопросов') {
    wizards[userId] = { step: 0, answers: {} };
    return await runWizard(ctx, userId);
  }

  // Популярные → wizard с предзаполненными параметрами
  if (POPULAR.includes(text)) {
    const cfg = POPULAR_CONFIG.find(p => p.label === text);
    wizards[userId] = {
      step: cfg.skipBudget ? (cfg.skipLocation ? 3 : 2) : 1,
      answers: { occasion: text },
      preParams: cfg.params,
      skipLocation: cfg.skipLocation,
    };
    return await runWizard(ctx, userId);
  }

  // Повтор после таймаута
  if (text === '🔄 Попробовать снова' && sessions[userId]) {
    return await showResults(ctx, userId);
  }

  // Пагинация
  if (text === '📄 Показать ещё' && sessions[userId]) {
    sessions[userId].page++;
    return await showResults(ctx, userId);
  }

  if (text === '🔄 Новый поиск') {
    delete sessions[userId];
    return ctx.reply('Хорошо, начнём заново. Что ищете?', mainKeyboard());
  }

  await ctx.sendChatAction('typing');

  try {
    const intent = await parseIntent(text);
    console.log('Intent:', JSON.stringify(intent));

    if (intent.off_topic) {
      await ctx.reply(
        'Это немного не по моей части 😅\n\n' +
        'Я специализируюсь на ресторанах и барах. Но вот что могу предложить прямо сейчас:'
      );
      await ctx.reply('⭐ Топ заведений Москвы', Markup.inlineKeyboard([[Markup.button.callback('Показать →', 'col_top')]]));
      await ctx.reply('🌆 Открыто сейчас', Markup.inlineKeyboard([[Markup.button.callback('Показать →', 'col_open')]]));
      await ctx.reply('Или напишите что ищете 👇', mainKeyboard());
      return;
    }

    if (intent.clarify && (intent.confidence || 1) < 0.7) {
      sessions[userId] = { params: {}, page: 1, lastQuery: text, pendingClarify: true };
      return ctx.reply('🤔 ' + intent.clarify, Markup.keyboard([['❌ Отмена'],['🔄 Новый поиск']]).resize());
    }

    if ((intent.confidence || 1) < 0.4) {
      await ctx.reply(
        'Не совсем понял запрос 🤔\n\n' +
        'Попробуйте написать иначе, например:\n' +
        '• «Бар у Арбатской»\n' +
        '• «Грузинский ресторан до 2000 руб»\n\n' +
        'Или выберите готовую подборку:'
      );
      await ctx.reply('⭐ Топ Москвы по рейтингу', Markup.inlineKeyboard([[Markup.button.callback('Показать →', 'col_top')]]));
      await ctx.reply('🌸 Открытые веранды', Markup.inlineKeyboard([[Markup.button.callback('Показать →', 'col_veranda')]]));
      await ctx.reply('💰 Хорошие места до 1500 руб', Markup.inlineKeyboard([[Markup.button.callback('Показать →', 'col_budget')]]));
      await ctx.reply('Или пройдите пошаговый подбор 👇',
        Markup.keyboard([['🤔 Задай мне 5 вопросов'], ['🔄 Новый поиск']]).resize());
      return;
    }

    const params = buildParams(intent);
    console.log('Params:', JSON.stringify(params));

    if (params['_metroNotFound']) {
      const nf = params['_metroNotFound']; delete params['_metroNotFound'];
      await ctx.reply('🚇 Станцию «' + nf + '» не нашёл в базе.\n\nПопробуйте полное название или укажите округ.');
      return;
    }

    sessions[userId] = { params, page: 1, lastQuery: text };
    await showResults(ctx, userId);
  } catch(e) {
    console.error('Ошибка:', e.message);
    ctx.reply('Что-то пошло не так. Попробуйте переформулировать запрос.');
  }
});

// ─── Ежедневный отчёт 21:00 МСК ──────────────────────────────────────────────
cron.schedule('0 21 * * *', async () => {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId || !stats.queries.length) { stats.resetDaily(); return; }
  const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
  const topMetros = Object.entries(stats.metros).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>k+': '+v).join(', ')||'—';
  const avgCheck = stats.checks.length ? Math.round(stats.checks.reduce((a,b)=>a+b,0)/stats.checks.length) : 0;
  const list = stats.queries.map((q,i)=>(i+1)+'. ['+q.time+'] '+q.name+': '+q.text+' - '+q.results+' рез.').join('\n');
  const report = 'Отчет за '+date+'\n\nПользователей: '+stats.users.size+'\nЗапросов: '+stats.queries.length+'\nТоп метро: '+topMetros+'\nСредний чек: '+(avgCheck||'—')+' руб.\n\nЗапросы:\n'+list;
  await bot.telegram.sendMessage(adminId, report.length>4000?report.substring(0,3900)+'\n...':report).catch(()=>{});
  stats.resetDaily();
}, { timezone: 'Europe/Moscow' });

// ─── Еженедельная рассылка подписок (вс 10:00) ───────────────────────────────
cron.schedule('0 10 * * 0', async () => {
  const subs = loadSubs();
  for (const [userId, userSubs] of Object.entries(subs)) {
    for (const sub of userSubs) {
      try {
        const resp = await apiGet('/search', { ...sub.params, newest: 1, page: 1, per_page: 3 });
        const bars = resp.data.data || [];
        if (!bars.length) continue;
        await bot.telegram.sendMessage(userId, '📬 Еженедельная подборка: *' + sub.label + '*', { parse_mode: 'Markdown' });
        for (const bar of bars) {
          barCache[bar.id] = bar;
          const text = formatBar(bar, bars.indexOf(bar)+1);
          const kb = barInlineKeyboard(bar);
          if (hasValidPhoto(bar.photo_url)) { try { await bot.telegram.sendPhoto(userId, bar.photo_url, { caption: text, parse_mode: 'Markdown', ...kb }); continue; } catch(e) {} }
          await bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...kb });
        }
      } catch(e) { console.error('Ошибка рассылки:', e.message); }
    }
  }
}, { timezone: 'Europe/Moscow' });

// ─── Старт ────────────────────────────────────────────────────────────────────
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Перехватываем необработанные ошибки чтобы не крашиться
process.on('uncaughtException', (e) => {
  console.error('uncaughtException:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection:', e && e.message ? e.message : e);
});

async function startBot() {
  let attempt = 0;
  while (true) {
    try {
      attempt++;
      console.log('Запуск бота, попытка ' + attempt);
      await bot.launch();
    } catch(e) {
      if (e.message && e.message.includes('409')) {
        console.log('409 конфликт — жду 5 сек и перезапускаю...');
        await new Promise(r => setTimeout(r, 5000));
      } else {
        console.error('Ошибка запуска:', e.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
}

console.log('GdeBar бот запускается...');
loadCache();
setInterval(loadCache, 6 * 60 * 60 * 1000);
startBot();

