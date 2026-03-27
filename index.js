require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

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
  const rating = bar.rating ? `${stars} ${bar.rating} (${bar.reviews_count} отз.)` : '';
  const check = bar.avg_check ? `💰 ${bar.avg_check} руб.` : '';
  const metro = bar.metro ? `🚇 ${bar.metro}${bar.metro_distance_m ? ` (${bar.metro_distance_m} м)` : ''}` : '';
  const cuisine = bar.cuisine?.length ? `🍽 ${bar.cuisine.slice(0, 3).join(', ')}` : '';
  const features = bar.features?.length ? `✅ ${bar.features.slice(0, 4).join(' · ')}` : '';
  const phone = bar.phone ? `📞 ${bar.phone}` : '';

  const lines = [
    `*${index}. ${bar.name}*`,
    rating, check, metro, cuisine, features, phone,
    bar.url ? `[Открыть на GdeBar.ru ↗](${bar.url})` : '',
  ].filter(Boolean);

  return lines.join('\n');
}

// ─── Состояние диалога ────────────────────────────────────────────────────────
const sessions = {};

// ─── Команды ──────────────────────────────────────────────────────────────────
bot.start(ctx => {
  return ctx.replyWithMarkdown(
    `👋 Привет! Я помогу найти ресторан, кафе или бар в Москве и Питере.\n\n` +
    `Просто напиши, что ищешь, например:\n` +
    `• *Грузинский ресторан у Арбатской до 2000 руб*\n` +
    `• *Бар с живой музыкой и кальяном*\n` +
    `• *Куда пойти с детьми рядом с Охотным рядом*\n` +
    `• *Ресторан для корпоратива на 30 человек*`
  );
});

bot.help(ctx => ctx.reply(
  'Напиши что ищешь — я переведу в фильтры и покажу топ заведений.\n\n' +
  'Можно указать: метро, кухню, бюджет, особенности (кальян, живая музыка, дети, веранда...).'
));

// ─── Основной обработчик сообщений ───────────────────────────────────────────
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Обработка кнопок пагинации
  if (text === '📄 Показать ещё' && sessions[userId]) {
    sessions[userId].page++;
    return await showResults(ctx, userId);
  }
  if (text === '🔄 Новый поиск') {
    delete sessions[userId];
    return ctx.reply('Хорошо, начнём заново. Что ищешь?');
  }

  await ctx.sendChatAction('typing');

  try {
    // Парсим намерение
    const intent = await parseIntent(text);
    console.log('Intent:', JSON.stringify(intent));

    const params = buildParams(intent);
    console.log('Params:', JSON.stringify(params));

    // Сохраняем сессию для пагинации
    sessions[userId] = { params, page: 1, lastQuery: text };

    await showResults(ctx, userId);
  } catch (e) {
    console.error('Ошибка:', e.message);
    ctx.reply('Что-то пошло не так. Попробуй переформулировать запрос.');
  }
});

async function showResults(ctx, userId) {
  const session = sessions[userId];
  if (!session) return;

  await ctx.sendChatAction('typing');

  const response = await api.get('/search', {
    params: { ...session.params, page: session.page, per_page: 3 },
  });

  const bars = response.data.data || [];
  const meta = response.data.meta || {};
  const total = meta.total || 0;
  const lastPage = meta.last_page || 1;

  if (bars.length === 0) {
    return ctx.reply(
      '😕 По твоему запросу ничего не нашлось. Попробуй смягчить фильтры — например, убери ограничение по бюджету или метро.',
      Markup.keyboard([['🔄 Новый поиск']]).resize()
    );
  }

  // Отправляем каждое заведение отдельным сообщением
  const offset = (session.page - 1) * 3;
  for (let i = 0; i < bars.length; i++) {
    await ctx.replyWithMarkdown(
      formatBar(bars[i], offset + i + 1),
      { disable_web_page_preview: false }
    );
  }

  // Итог и кнопки
  const hasMore = session.page < lastPage;
  const keyboard = hasMore
    ? Markup.keyboard([['📄 Показать ещё'], ['🔄 Новый поиск']]).resize()
    : Markup.keyboard([['🔄 Новый поиск']]).resize();

  const summary = `Найдено: ${total} заведений. Показаны ${offset + 1}–${offset + bars.length}.`;
  await ctx.reply(summary, keyboard);
}

// ─── Старт ───────────────────────────────────────────────────────────────────
loadCache().then(() => {
  bot.launch();
  console.log('🤖 GdeBar бот запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
