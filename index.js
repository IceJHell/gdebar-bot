require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');

const bot = new Telegraf(process.env.BOT_TOKEN);
const API_BASE = 'https://www.gdebar.ru/api/v1';
const API_TOKEN = process.env.GDEBAR_API_TOKEN;

// ─── HTTP клиент ──────────────────────────────────────────────────────────────
const api = axios.create({
  baseURL: API_BASE,
  headers: { Authorization: `Bearer ${API_TOKEN}` },
  timeout: 10000,
});

// ─── Справочники (кэш при старте) ────────────────────────────────────────────
let CACHE = { metros: [], kitchens: [], types: [], goodFor: [] };

async function loadCache() {
  try {
    const [metros, kitchens, types, goodFor] = await Promise.all([
      api.get('/metros'),
      api.get('/kitchens'),
      api.get('/types'),
      api.get('/good-for'),
    ]);
    CACHE.metros   = Array.isArray(metros.data)   ? metros.data   : (metros.data.data   || []);
    CACHE.kitchens = Array.isArray(kitchens.data) ? kitchens.data : (kitchens.data.data || []);
    CACHE.types    = Array.isArray(types.data)    ? types.data    : (types.data.data    || []);
    CACHE.goodFor  = Array.isArray(goodFor.data)  ? goodFor.data  : (goodFor.data.data  || []);
    console.log('✅ Справочники загружены:', {
      metros: CACHE.metros.length,
      kitchens: CACHE.kitchens.length,
      types: CACHE.types.length,
      goodFor: CACHE.goodFor.length,
    });
  } catch (e) {
    console.error('❌ Ошибка загрузки справочников:', e.message);
  }
}

// ─── Парсер намерений (Claude API) ───────────────────────────────────────────
async function parseIntent(userMessage) {
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `Ты — парсер запросов для поиска ресторанов в Москве/СПб.
Из сообщения пользователя извлеки параметры поиска и верни ТОЛЬКО JSON без пояснений.

Доступные параметры:
- metro_name: название станции метро (строка, как пользователь назвал)
- kitchen: тип кухни (строка, например "грузинская", "японская")
- price_to: максимальный средний чек в рублях (число)
- price_from: минимальный средний чек
- options: массив особенностей из списка: kid, wifi, veranda, hookah, karaoke, live_music, dj, dancefloor, kabinki, parking, lunch, beer, cocktails, roof, water, clock
- type: тип заведения (строка: ресторан, бар, кафе, клуб, кофейня, паб)
- banket_for: тип мероприятия (строка: день рождения, корпоратив, свадьба, девичник, новый год)
- opened_now: true если хотят открытое сейчас
- city: "spb" если Санкт-Петербург, иначе не включай
- good_for: особенность (строка: панорамный вид, камин, завтраки, с собакой, романтическая атмосфера, уютные)

Пример входа: "хочу грузинский ресторан у Арбатской с кальяном до 2000 рублей"
Пример выхода: {"metro_name":"Арбатская","kitchen":"грузинская","options":["hookah"],"price_to":2000}

Если параметр не упомянут — не включай его в JSON.`,
        messages: [{ role: 'user', content: userMessage }],
      },
      { headers: { 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' } }
    );
    const text = resp.data.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Ошибка парсинга намерения:', e.message);
    return {};
  }
}

// ─── Преобразование намерений в параметры API ─────────────────────────────────
function buildParams(intent) {
  const params = {};

  // Метро — ищем по имени в кэше
  if (intent.metro_name) {
    const name = intent.metro_name.toLowerCase();
    const metro = CACHE.metros.find(m =>
      m.name.toLowerCase().includes(name) || name.includes(m.name.toLowerCase().split(' ')[0])
    );
    if (metro) params['metro[]'] = metro.id;
  }

  // Кухня — ищем по имени в кэше
  if (intent.kitchen) {
    const name = intent.kitchen.toLowerCase();
    const kitchen = CACHE.kitchens.find(k => k.name.toLowerCase().includes(name));
    if (kitchen) params['kitchen[]'] = kitchen.id;
  }

  // Тип заведения
  if (intent.type) {
    const name = intent.type.toLowerCase();
    const type = CACHE.types.find(t => t.name.toLowerCase().includes(name));
    if (type) params['type[]'] = type.id;
  }

  // Банкет
  if (intent.banket_for) {
    const name = intent.banket_for.toLowerCase();
    const banketMap = {
      'день рождения': 1, 'новый год': 2, 'корпоратив': 3,
      'свадьба': 4, 'юбилей': 4, 'детский': 5, 'девичник': 6, 'мальчишник': 6,
    };
    for (const [key, id] of Object.entries(banketMap)) {
      if (name.includes(key)) { params['banket[good_for][]'] = id; break; }
    }
  }

  // good_for — особенности
  if (intent.good_for) {
    const name = intent.good_for.toLowerCase();
    const gf = CACHE.goodFor.find(g => g.name.toLowerCase().includes(name));
    if (gf) params['good_for[]'] = gf.id;
  }

  // Чек
  if (intent.price_from) params['middleCheck[from]'] = intent.price_from;
  if (intent.price_to)   params['middleCheck[to]']   = intent.price_to;

  // Открыто сейчас
  if (intent.opened_now) params['opened_now'] = 'on';

  // Город
  if (intent.city === 'spb') params['city'] = 'spb';

  // Опции
  if (Array.isArray(intent.options)) {
    for (const opt of intent.options) {
      params[`options[${opt}]`] = 'on';
    }
  }

  return params;
}

// ─── Форматирование карточки заведения ───────────────────────────────────────
function formatBar(bar, index) {
  const stars = bar.rating >= 9 ? '🌟' : bar.rating >= 7 ? '⭐' : '✨';
  const rating = bar.rating ? `${stars} *${bar.rating}* (${bar.reviews_count} отз.)` : '';
  const check = bar.avg_check ? `💰 ${bar.avg_check} руб.` : '';
  const metro = bar.metro ? `🚇 ${bar.metro}${bar.metro_distance_m ? ` · ${bar.metro_distance_m} м` : ''}` : '';
  const cuisine = bar.cuisine?.length ? `🍽 ${bar.cuisine.slice(0, 3).join(', ')}` : '';
  const features = bar.features?.length ? `✨ ${bar.features.slice(0, 5).join(' · ')}` : '';
  const phone = bar.phone ? `📞 ${bar.phone}` : '';
  const desc = bar.description
    ? bar.description.slice(0, 130).trim() + (bar.description.length > 130 ? '…' : '')
    : '';

  const lines = [
    `*${index}. ${bar.name}*`,
    rating,
    [check, metro].filter(Boolean).join('   '),
    cuisine,
    desc ? `\n_${desc}_` : '',
    features,
    phone,
    bar.url ? `[Открыть на GdeBar.ru ↗](${bar.url})` : '',
  ].filter(Boolean);

  return lines.join('\n');
}

function hasValidPhoto(url) {
  return url && url.startsWith('http') && !url.includes('placeholder') && !url.includes('localhost');
}

// ─── Состояние диалога ────────────────────────────────────────────────────────
const sessions = {};

// ─── Статистика ───────────────────────────────────────────────────────────────
const stats = {
  users: new Set(),      // уникальные userId за день
  queries: [],           // { userId, name, text, time, results }
  resetDaily() {
    this.users = new Set();
    this.queries = [];
  }
};

function trackQuery(ctx, queryText, resultsCount) {
  stats.users.add(ctx.from.id);
  stats.queries.push({
    name: ctx.from.first_name || 'Пользователь',
    text: queryText,
    time: new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }),
    results: resultsCount,
  });
}

// ─── Wizard (5 вопросов) ─────────────────────────────────────────────────────
const wizards = {};

const WIZARD_QUESTIONS = [
  { key: 'location', text: '📍 *Где территориально?*\n\nНапишите станцию метро, район или округ — например, «Арбатская», «ЦАО», «рядом с Садовым кольцом».' },
  { key: 'budget',   text: '💰 *Какой средний чек на человека?*\n\nНапишите сумму в рублях — например, «до 1500», «1500-3000», «не важно».' },
  { key: 'guests',   text: '👥 *Сколько вас будет человек?*' },
  { key: 'occasion', text: '🎉 *Какой тип мероприятия?*\n\nНапример: обычный ужин, день рождения, корпоратив, романтическое свидание, детский праздник, бизнес-встреча...' },
  { key: 'features', text: '✨ *Какие особенности важны?*\n\nНапример: живая музыка, кальян, веранда, кабинки, парковка, детская комната, панорамный вид — или напишите «без предпочтений».' },
];

async function runWizard(ctx, userId) {
  const w = wizards[userId];
  if (!w) return;

  if (w.step < WIZARD_QUESTIONS.length) {
    await ctx.replyWithMarkdown(
      `Вопрос ${w.step + 1} из ${WIZARD_QUESTIONS.length}\n\n` + WIZARD_QUESTIONS[w.step].text,
      Markup.keyboard([['❌ Отмена']]).resize()
    );
  } else {
    // Все ответы собраны — формируем запрос
    delete wizards[userId];
    const { location, budget, guests, occasion, features } = w.answers;
    const query = [
      location !== 'не важно' ? location : '',
      occasion !== 'обычный ужин' && occasion !== 'не важно' ? occasion : '',
      features !== 'без предпочтений' && features !== 'не важно' ? features : '',
      budget !== 'не важно' ? `бюджет ${budget}` : '',
      guests ? `компания ${guests} человек` : '',
    ].filter(Boolean).join(', ');
    await ctx.reply(`Отлично, ищу по запросу: ${query}`);
    sessions[userId] = { params: {}, page: 1, lastQuery: query };
    // Парсим как обычный запрос
    await ctx.sendChatAction('typing');
    const intent = await parseIntent(query);
    sessions[userId].params = buildParams(intent);
    await showResults(ctx, userId);
  }
}

// ─── Команды ──────────────────────────────────────────────────────────────────
const POPULAR = [
  '🍷 Романтический ужин',
  '🎂 День рождения',
  '💼 Бизнес-встреча',
  '🍻 Бар с живой музыкой',
  '🌿 С верандой на свежем воздухе',
  '👨‍👩‍👧 С детьми',
  '🎤 Вечер с кальяном и DJ',
  '🌅 Панорамный вид',
  '🎄 Апрельские посиделки после зимы',
  '🐣 Весеннее настроение — куда выйти в апреле',
];

bot.start(async ctx => {
  await ctx.replyWithMarkdown(
    `👋 Привет! Я помогу найти ресторан, кафе или бар в Москве и Санкт-Петербурге.\n\n` +
    `Просто напишите что ищете — или выберите популярную подборку ниже 👇`,
    Markup.keyboard([
      ...POPULAR.map(p => [p]),
      ['🤔 Задай мне 5 вопросов'],
      ['🔄 Новый поиск'],
    ]).resize()
  );
});

bot.help(ctx => ctx.replyWithMarkdown(
  '*Как пользоваться ботом:*\n\n' +
  '• Напишите запрос в свободной форме\n' +
  '• Или выберите популярную подборку\n' +
  '• Или нажмите «Задай мне 5 вопросов» — и я помогу подобрать пошагово\n\n' +
  'Можно указать: метро, кухню, бюджет, особенности (кальян, веранда, дети, живая музыка...)'
));

// ─── Основной обработчик сообщений ───────────────────────────────────────────
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Wizard: отмена
  if (text === '❌ Отмена' && wizards[userId]) {
    delete wizards[userId];
    return ctx.reply('Хорошо, отменили. Напишите запрос в свободной форме или выберите подборку.', Markup.keyboard([
      ...POPULAR.map(p => [p]),
      ['🤔 Задай мне 5 вопросов'],
      ['🔄 Новый поиск'],
    ]).resize());
  }

  // Wizard: обработка ответа
  if (wizards[userId]) {
    const w = wizards[userId];
    const key = WIZARD_QUESTIONS[w.step].key;
    w.answers[key] = text;
    w.step++;
    return await runWizard(ctx, userId);
  }

  // Запуск wizard
  if (text === '🤔 Задай мне 5 вопросов') {
    wizards[userId] = { step: 0, answers: {} };
    return await runWizard(ctx, userId);
  }

  // Пагинация
  if (text === '📄 Показать ещё' && sessions[userId]) {
    sessions[userId].page++;
    return await showResults(ctx, userId);
  }
  if (text === '🔄 Новый поиск') {
    delete sessions[userId];
    return ctx.reply('Хорошо, начнём заново. Что ищете?', Markup.keyboard([
      ...POPULAR.map(p => [p]),
      ['🤔 Задай мне 5 вопросов'],
      ['🔄 Новый поиск'],
    ]).resize());
  }

  await ctx.sendChatAction('typing');

  try {
    const intent = await parseIntent(text);
    console.log('Intent:', JSON.stringify(intent));
    const params = buildParams(intent);
    console.log('Params:', JSON.stringify(params));
    sessions[userId] = { params, page: 1, lastQuery: text };
    await showResults(ctx, userId);
  } catch (e) {
    console.error('Ошибка:', e.message);
    ctx.reply('Что-то пошло не так. Попробуйте переформулировать запрос.');
  }
});

const SEARCH_MESSAGES_1 = [
  '🔍 Сейчас поищем что-нибудь подходящее, уже смотрю варианты для вас...',
  '🔍 Секунду, просматриваю заведения по вашему запросу...',
  '🔍 Уже ищу — сейчас найдём что-то хорошее для вас...',
  '🔍 Хорошо, начинаю подбор. Смотрю что есть интересного...',
];

const SEARCH_MESSAGES_2 = [
  '✨ Нашлось несколько вариантов, уже почти готово — формирую для вас...',
  '✨ Отличные заведения попались, сейчас оформлю и покажу...',
  '✨ Вижу хорошие варианты, собираю карточки — ещё секунду...',
  '✨ Уже почти всё готово, осталось чуть-чуть...',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function showResults(ctx, userId) {
  const session = sessions[userId];
  if (!session) return;

  const isFirstPage = session.page === 1;

  if (isFirstPage) {
    // Сообщение 1 — сразу
    await ctx.reply(rnd(SEARCH_MESSAGES_1));
    await ctx.sendChatAction('typing');
  }

  // Запрос к API (параллельно с ожиданием)
  const [response] = await Promise.all([
    api.get('/search', { params: { ...session.params, page: session.page, per_page: 6 } }),
    isFirstPage ? sleep(3000) : Promise.resolve(),
  ]);

  const allBars = response.data.data || [];
  const meta = response.data.meta || {};
  const total = meta.total || 0;
  const lastPage = meta.last_page || 1;

  if (allBars.length === 0) {
    return ctx.reply(
      '😕 По вашему запросу ничего не нашлось. Попробуйте смягчить фильтры — например, убрать ограничение по бюджету или метро.',
      Markup.keyboard([['🔄 Новый поиск']]).resize()
    );
  }

  // Приоритет — заведения с телефоном
  const withPhone = allBars.filter(b => b.phone);
  const withoutPhone = allBars.filter(b => !b.phone);
  const sorted = [...withPhone, ...withoutPhone].slice(0, 3);

  if (isFirstPage) {
    // Сообщение 2 — через ~3 сек после первого
    await ctx.reply(rnd(SEARCH_MESSAGES_2));
    await ctx.sendChatAction('typing');
    await sleep(3000);
  }

  // Трекинг запроса
  if (isFirstPage) trackQuery(ctx, session.lastQuery || '', sorted.length);

  // Отправляем карточки
  const offset = (session.page - 1) * 3;
  for (let i = 0; i < sorted.length; i++) {
    const bar = sorted[i];
    const text = formatBar(bar, offset + i + 1);
    if (hasValidPhoto(bar.photo_url)) {
      try {
        await ctx.replyWithPhoto(bar.photo_url, { caption: text, parse_mode: 'Markdown' });
        continue;
      } catch (e) { /* fallback */ }
    }
    await ctx.replyWithMarkdown(text, { disable_web_page_preview: true });
  }

  // Итоговое сообщение + кнопки
  const hasMore = session.page < lastPage;
  const keyboard = hasMore
    ? Markup.keyboard([['📄 Показать ещё'], ['🔄 Новый поиск']]).resize()
    : Markup.keyboard([['🔄 Новый поиск']]).resize();

  const outro = `Вот что удалось подобрать — ${total} заведений по вашему запросу, показываю лучшие.
Переходите по ссылке на сайт, там полное меню, фото и отзывы 👆`;
  await ctx.reply(outro, keyboard);
}

// ─── Старт ───────────────────────────────────────────────────────────────────
// ─── Ежедневный отчёт в 21:00 МСК ───────────────────────────────────────────
cron.schedule('0 21 * * *', async () => {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) return;

  const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
  const totalUsers = stats.users.size;
  const totalQueries = stats.queries.length;

  if (totalQueries === 0) {
    await bot.telegram.sendMessage(adminId, `📊 *Отчёт за ${date}*\n\nЗапросов за день не было.`, { parse_mode: 'Markdown' });
    stats.resetDaily();
    return;
  }

  const queryList = stats.queries
    .map((q, i) => `${i + 1}. [${q.time}] ${q.name}: _${q.text}_ → ${q.results} рез.`)
    .join('\n');

  const report = [
    `📊 *Отчёт за ${date}*`,
    ``,
    `👥 Уникальных пользователей: *${totalUsers}*`,
    `🔍 Всего запросов: *${totalQueries}*`,
    ``,
    `*Запросы:*`,
    queryList,
    ``,
    `_Переходы по ссылкам Telegram не отслеживает — используйте utm\_campaign=tg\_bot\_ai в Яндекс.Метрике_`,
  ].join('\n');

  // Telegram ограничивает 4096 символов
  if (report.length > 4000) {
    const short = report.substring(0, 3900) + '\n...и ещё запросы (обрезано)';
    await bot.telegram.sendMessage(adminId, short, { parse_mode: 'Markdown' });
  } else {
    await bot.telegram.sendMessage(adminId, report, { parse_mode: 'Markdown' });
  }

  stats.resetDaily();
}, { timezone: 'Europe/Moscow' });

loadCache().then(() => {
  bot.launch();
  console.log('🤖 GdeBar бот запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
