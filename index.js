require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');

const bot = new Telegraf(process.env.BOT_TOKEN);
const API_BASE = 'https://www.gdebar.ru/api/v1';
const API_TOKEN = process.env.GDEBAR_API_TOKEN;

const api = axios.create({
  baseURL: API_BASE,
  headers: { Authorization: `Bearer ${API_TOKEN}` },
  timeout: 10000,
});

// Справочники
let CACHE = { metros: [], kitchens: [], types: [], goodFor: [] };

async function loadCache() {
  try {
    const [metros, kitchens, types, goodFor] = await Promise.all([
      api.get('/metros'), api.get('/kitchens'), api.get('/types'), api.get('/good-for'),
    ]);
    CACHE.metros   = Array.isArray(metros.data)   ? metros.data   : (metros.data.data   || []);
    CACHE.kitchens = Array.isArray(kitchens.data) ? kitchens.data : (kitchens.data.data || []);
    CACHE.types    = Array.isArray(types.data)    ? types.data    : (types.data.data    || []);
    CACHE.goodFor  = Array.isArray(goodFor.data)  ? goodFor.data  : (goodFor.data.data  || []);
    console.log('Справочники загружены:', { metros: CACHE.metros.length, kitchens: CACHE.kitchens.length, types: CACHE.types.length, goodFor: CACHE.goodFor.length });
  } catch (e) {
    console.error('Ошибка загрузки справочников:', e.message);
  }
}

// Claude API — консьерж
async function parseIntent(userMessage) {
  try {
    const now = new Date();
    const moscowTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(now);
    const moscowDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: 'long', year: 'numeric' }).format(now);
    const weekdays = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
    const weekday = weekdays[new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getDay()];

    const systemPrompt = 'Ты — опытный консьерж ресторанного гида GdeBar.ru.\n'
      + 'Твоя задача: понять что человек РЕАЛЬНО хочет и извлечь параметры поиска.\n\n'
      + 'КОНТЕКСТ:\n'
      + '- Сервис: рестораны, кафе, бары Москвы и Санкт-Петербурга\n'
      + '- Сегодня: ' + moscowDate + ', ' + moscowTime + ' по Москве, день недели: ' + weekday + '\n\n'
      + 'ЛОГИКА (думай как консьерж):\n\n'
      + '1. ИНТЕРПРЕТИРУЙ НАМЕРЕНИЕ:\n'
      + '   - "посидеть после работы" -> opened_now=true, options:[bar_desk, cocktails]\n'
      + '   - "нас двое, атмосферно" -> good_for: романтика\n'
      + '   - "компания 10 человек" -> banket_for с вместимостью\n'
      + '   - "на обед что-то лёгкое" -> options:[lunch], price_to:1200\n'
      + '   - "с детьми" -> options:[kid]\n\n'
      + '2. БЮДЖЕТ:\n'
      + '   - "бюджетно"/"недорого" -> price_to:1200\n'
      + '   - "средний" -> price_to:2500\n'
      + '   - "без ограничений"/"хорошее место" -> не включай price\n'
      + '   - "дорогой" -> price_from:3000\n\n'
      + '3. МЕТРО: бери точно как написал пользователь, даже с ошибкой\n\n'
      + '4. УВЕРЕННОСТЬ:\n'
      + '   - 0.9+: четкий запрос\n'
      + '   - 0.6-0.9: понятно, небольшие неоднозначности\n'
      + '   - 0.3-0.6: размытый — добавь clarify с одним вопросом\n'
      + '   - 0-0.3: не про рестораны -> off_topic:true\n\n'
      + '5. СПЕЦСЛУЧАИ:\n'
      + '   - Конкретное название -> venue_name\n'
      + '   - Не про рестораны -> off_topic:true\n'
      + '   - Питер -> city:"spb"\n\n'
      + 'ВЕРНИ ТОЛЬКО JSON, только заполненные поля:\n'
      + '{"metro_name":"...","kitchen":"...","type":"...","price_from":0,"price_to":0,"options":[],"good_for":"...","banket_for":"...","opened_now":true,"city":"spb","venue_name":"...","confidence":0.9,"off_topic":false,"clarify":"..."}';

    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      { headers: { 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' } }
    );
    const raw = resp.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (e) {
    console.error('Ошибка parseIntent:', e.message);
    return {};
  }
}

// Параметры запроса
function buildParams(intent) {
  const params = {};
  if (intent.venue_name) params['term'] = intent.venue_name;
  if (intent.metro_name) {
    const name = intent.metro_name.toLowerCase();
    const metro = CACHE.metros.find(m =>
      m.name.toLowerCase().includes(name) || name.includes(m.name.toLowerCase().split(' ')[0])
    );
    if (metro) params['metro[]'] = metro.id;
  }
  if (intent.kitchen) {
    const k = CACHE.kitchens.find(x => x.name.toLowerCase().includes(intent.kitchen.toLowerCase()));
    if (k) params['kitchen[]'] = k.id;
  }
  if (intent.type) {
    const t = CACHE.types.find(x => x.name.toLowerCase().includes(intent.type.toLowerCase()));
    if (t) params['type[]'] = t.id;
  }
  if (intent.banket_for) {
    const map = { 'день рождения':1, 'новый год':2, 'корпоратив':3, 'свадьба':4, 'юбилей':4, 'детский':5, 'девичник':6 };
    const n = intent.banket_for.toLowerCase();
    for (const [k, v] of Object.entries(map)) { if (n.includes(k)) { params['banket[good_for][]'] = v; break; } }
  }
  if (intent.good_for) {
    const gf = CACHE.goodFor.find(x => x.name.toLowerCase().includes(intent.good_for.toLowerCase()));
    if (gf) params['good_for[]'] = gf.id;
  }
  if (intent.price_from) params['middleCheck[from]'] = intent.price_from;
  if (intent.price_to)   params['middleCheck[to]']   = intent.price_to;
  if (intent.opened_now) params['opened_now'] = 'on';
  if (intent.city === 'spb') params['city'] = 'spb';
  if (Array.isArray(intent.options)) {
    for (const opt of intent.options) params[`options[${opt}]`] = 'on';
  }
  return params;
}

// Форматирование карточки
function formatBar(bar, index) {
  const stars = bar.rating >= 9 ? '🌟' : bar.rating >= 7 ? '⭐' : '✨';
  const lines = [
    '*' + index + '. ' + bar.name + '*',
    '',
    bar.rating ? stars + ' *' + bar.rating + '* (' + bar.reviews_count + ' отз.)' : '',
    bar.avg_check ? '💰 Средний чек — ' + bar.avg_check + ' руб.' : '',
    bar.metro ? '🚇 ' + bar.metro + (bar.metro_distance_m ? ' · ' + bar.metro_distance_m + ' м' : '') : '',
    bar.cuisine?.length ? '🍽 ' + bar.cuisine.slice(0, 3).join(', ') : '',
    '',
    bar.description ? '_' + bar.description.slice(0, 160).trim() + (bar.description.length > 160 ? '…' : '') + '_' : '',
    '',
    bar.features?.length ? '✨ ' + bar.features.slice(0, 5).join(' · ') : '',
    '',
    bar.phone ? '📞 ' + bar.phone : '',
    bar.url ? '[Подробнее на нашем сайте ↗](' + bar.url + ')' : '',
  ].filter(x => x !== undefined);
  return lines.join('\n\n');
}

function hasValidPhoto(url) {
  return url && url.startsWith('http') && !url.includes('placeholder') && !url.includes('localhost');
}

// Статистика
const stats = { users: new Set(), queries: [], resetDaily() { this.users = new Set(); this.queries = []; } };
function trackQuery(ctx, queryText, count) {
  stats.users.add(ctx.from.id);
  stats.queries.push({
    name: ctx.from.first_name || 'Пользователь',
    text: queryText,
    time: new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }),
    results: count,
  });
}

// Состояние
const sessions = {};
const wizards  = {};

// Сообщения ожидания
const MSG1 = [
  '🔍 Сейчас поищем что-нибудь подходящее, уже смотрю варианты...',
  '🔍 Секунду, просматриваю заведения по вашему запросу...',
  '🔍 Уже ищу — сейчас найдём что-то хорошее...',
];
const MSG2 = [
  '✨ Нашлось несколько вариантов, формирую для вас...',
  '✨ Хорошие заведения попались, сейчас покажу...',
  '✨ Вижу отличные варианты, собираю карточки...',
];
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Wizard
const WIZARD_Q = [
  { key: 'location', text: '📍 *Где территориально?*\n\nМетро, район или округ — например, «Арбатская», «ЦАО».' },
  { key: 'budget',   text: '💰 *Средний чек на человека?*\n\nНапример: «до 1500», «1500–3000», «не важно».' },
  { key: 'guests',   text: '👥 *Сколько вас будет человек?*' },
  { key: 'occasion', text: '🎉 *Тип мероприятия?*\n\nУжин, день рождения, корпоратив, свидание, детский праздник...' },
  { key: 'features', text: '✨ *Какие особенности важны?*\n\nЖивая музыка, кальян, веранда, кабинки, парковка — или «без предпочтений».' },
];
async function runWizard(ctx, userId) {
  const w = wizards[userId];
  if (!w) return;
  if (w.step < WIZARD_Q.length) {
    await ctx.replyWithMarkdown('Вопрос ' + (w.step+1) + ' из ' + WIZARD_Q.length + '\n\n' + WIZARD_Q[w.step].text, Markup.keyboard([['❌ Отмена']]).resize());
  } else {
    delete wizards[userId];
    const { location, budget, occasion, features, guests } = w.answers;
    const query = [
      location !== 'не важно' ? location : '',
      occasion && occasion !== 'обычный ужин' && occasion !== 'не важно' ? occasion : '',
      features && features !== 'без предпочтений' ? features : '',
      budget && budget !== 'не важно' ? 'бюджет ' + budget : '',
      guests ? 'компания ' + guests + ' человек' : '',
    ].filter(Boolean).join(', ');
    await ctx.reply('Отлично, ищу: ' + query);
    const intent = await parseIntent(query);
    sessions[userId] = { params: buildParams(intent), page: 1, lastQuery: query };
    await showResults(ctx, userId);
  }
}

// Популярные подборки
const POPULAR = [
  '🍷 Романтический ужин',
  '🎂 День рождения',
  '💼 Бизнес-встреча',
  '🍻 Бар с живой музыкой',
  '🌿 С верандой на свежем воздухе',
  '👨‍👩‍👧 С детьми',
  '🎤 Кальян и DJ',
  '🌅 Панорамный вид',
  '🐣 Куда выйти в апреле',
  '🎯 Что-то необычное',
];
function mainKeyboard() {
  return Markup.keyboard([...POPULAR.map(p => [p]), ['🤔 Задай мне 5 вопросов'], ['🔄 Новый поиск']]).resize();
}

// Команды
bot.start(async ctx => {
  await ctx.reply(
    'Привет! 👋\n\n' +
    'Меня зовут Алекс, я помогаю подбирать рестораны, кафе и бары в Москве и Санкт-Петербурге.\n\n' +
    'На сайте GdeBar.ru собраны тысячи заведений — с меню, фото, отзывами и возможностью забронировать столик онлайн. ' +
    'Я помогу быстро найти то, что подойдёт именно вам — по настроению, бюджету и компании.\n\n' +
    'Для начала скажите: вы ищете в каком городе?',
    Markup.keyboard([['🏙 Москва', '🌊 Санкт-Петербург']]).resize()
  );
});
bot.help(ctx => ctx.reply(
  'Напишите что ищете в свободной форме или выберите подборку.\nМожно указать: метро, кухню, бюджет, особенности.'
));

// Показ результатов
async function showResults(ctx, userId) {
  const session = sessions[userId];
  if (!session) return;
  const isFirst = session.page === 1;

  if (isFirst) {
    await ctx.reply(rnd(MSG1));
    await ctx.sendChatAction('typing');
  }

  const [response] = await Promise.all([
    api.get('/search', { params: { ...session.params, page: session.page, per_page: 6 } }),
    isFirst ? sleep(3000) : Promise.resolve(),
  ]);

  const allBars  = response.data.data || [];
  const meta     = response.data.meta || {};
  const total    = meta.total || 0;
  const lastPage = meta.last_page || 1;

  if (allBars.length === 0) {
    return ctx.reply(
      '😕 По вашему запросу ничего не нашлось.\n\nПопробуйте убрать ограничение по бюджету, сменить метро или упростить запрос.\nИли нажмите «Задай мне 5 вопросов» 👇',
      Markup.keyboard([['🤔 Задай мне 5 вопросов'], ['🔄 Новый поиск']]).resize()
    );
  }

  const withPhone    = allBars.filter(b => b.phone);
  const withoutPhone = allBars.filter(b => !b.phone);
  const sorted = [...withPhone, ...withoutPhone].slice(0, 3);

  if (isFirst) {
    trackQuery(ctx, session.lastQuery || '', sorted.length);
    await ctx.reply(rnd(MSG2));
    await ctx.sendChatAction('typing');
    await sleep(2500);
  }

  const offset = (session.page - 1) * 3;
  for (let i = 0; i < sorted.length; i++) {
    const bar  = sorted[i];
    const text = formatBar(bar, offset + i + 1);
    if (hasValidPhoto(bar.photo_url)) {
      try { await ctx.replyWithPhoto(bar.photo_url, { caption: text, parse_mode: 'Markdown' }); continue; } catch (e) {}
    }
    await ctx.replyWithMarkdown(text, { disable_web_page_preview: true });
  }

  const hasMore = session.page < lastPage;
  await ctx.reply(
    'Вот что подобрал — ' + total + ' заведений по вашему запросу, показываю лучшие.',
    hasMore
      ? Markup.keyboard([['📄 Показать ещё'], ['🔄 Новый поиск']]).resize()
      : Markup.keyboard([['🔄 Новый поиск']]).resize()
  );

  // Отложенное сообщение через 10 секунд
  if (isFirst) {
    setTimeout(async () => {
      try {
        await ctx.reply(
          'Кстати, советую не останавливаться только на фото 🙂\n\n' +
          'На сайте каждого заведения вы найдёте полное меню, живые отзывы, актуальные фото и форму бронирования. ' +
          'Если уже присмотрели что-то — звоните напрямую по номеру телефона или бронируйте столик онлайн прямо там.\n\n' +
          'Если ни один вариант не подошёл — напишите, что не так, подберём другое 👇'
        );
      } catch (e) { /* пользователь мог уйти */ }
    }, 10000);
  }
}

// Основной обработчик
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const text   = ctx.message.text;

  // Выбор города
  if (text === '🏙 Москва' || text === '🌊 Санкт-Петербург') {
    const city = text === '🌊 Санкт-Петербург' ? 'spb' : 'msk';
    sessions[userId] = { params: city === 'spb' ? { city: 'spb' } : {}, page: 1, lastQuery: '', city };
    const cityName = city === 'spb' ? 'Петербурге' : 'Москве';
    await ctx.reply(
      'Отлично, ищем в ' + cityName + '! 🗺\n\n' +
      'Куда бы вы хотели пойти? Можете написать своими словами или выбрать из популярного:\n\n' +
      '• Романтический ужин на двоих\n' +
      '• Бар с живой музыкой после работы\n' +
      '• Ресторан для дня рождения компанией\n' +
      '• Кафе с детьми на выходных\n' +
      '• Деловой обед или бизнес-встреча\n' +
      '• Место с верандой и свежим воздухом',
      mainKeyboard()
    );
    return;
  }

  // Ответ на уточняющий вопрос
  if (sessions[userId]?.pendingClarify && !wizards[userId] && text !== '🔄 Новый поиск' && text !== '❌ Отмена') {
    const combined = sessions[userId].lastQuery + '. ' + text;
    delete sessions[userId].pendingClarify;
    await ctx.sendChatAction('typing');
    try {
      const intent = await parseIntent(combined);
      sessions[userId] = { params: buildParams(intent), page: 1, lastQuery: combined };
      return await showResults(ctx, userId);
    } catch (e) { return ctx.reply('Что-то пошло не так. Попробуйте ещё раз.'); }
  }

  // Отмена
  if (text === '❌ Отмена') {
    delete wizards[userId]; delete sessions[userId];
    return ctx.reply('Хорошо, отменили. Что ищете?', mainKeyboard());
  }

  // Wizard — сбор ответов
  if (wizards[userId]) {
    wizards[userId].answers[WIZARD_Q[wizards[userId].step].key] = text;
    wizards[userId].step++;
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
    return ctx.reply('Хорошо, начнём заново. Что ищете?', mainKeyboard());
  }

  await ctx.sendChatAction('typing');

  try {
    const intent = await parseIntent(text);
    console.log('Intent:', JSON.stringify(intent));

    if (intent.off_topic) {
      return ctx.reply(
        'Я специализируюсь только на поиске ресторанов, кафе и баров в Москве и Питере.\n\nНапишите что-нибудь вроде «бар с живой музыкой» или выберите подборку 👇',
        mainKeyboard()
      );
    }

    if (intent.clarify && (intent.confidence || 1) < 0.7) {
      sessions[userId] = { params: {}, page: 1, lastQuery: text, pendingClarify: true };
      return ctx.reply('🤔 ' + intent.clarify, Markup.keyboard([['❌ Отмена'], ['🔄 Новый поиск']]).resize());
    }

    if ((intent.confidence || 1) < 0.4) {
      return ctx.reply(
        'Не совсем понял запрос. Попробуйте переформулировать — например:\n\n• «Ресторан у метро Тверская до 2000 руб»\n• «Бар с кальяном и живой музыкой»\n• «Куда пойти с детьми»\n\nИли нажмите «Задай мне 5 вопросов» 👇',
        Markup.keyboard([['🤔 Задай мне 5 вопросов'], ['🔄 Новый поиск']]).resize()
      );
    }

    const params = buildParams(intent);
    console.log('Params:', JSON.stringify(params));
    sessions[userId] = { params, page: 1, lastQuery: text };
    await showResults(ctx, userId);
  } catch (e) {
    console.error('Ошибка:', e.message);
    ctx.reply('Что-то пошло не так. Попробуйте переформулировать запрос.');
  }
});

// Ежедневный отчёт 21:00 МСК
cron.schedule('0 21 * * *', async () => {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) return;
  const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
  if (stats.queries.length === 0) {
    await bot.telegram.sendMessage(adminId, '📊 *Отчёт за ' + date + '*\n\nЗапросов не было.', { parse_mode: 'Markdown' });
    stats.resetDaily(); return;
  }
  const list = stats.queries.map((q, i) => (i+1) + '. [' + q.time + '] ' + q.name + ': _' + q.text + '_ → ' + q.results + ' рез.').join('\n');
  const report = '📊 *Отчёт за ' + date + '*\n\n👥 Пользователей: *' + stats.users.size + '*\n🔍 Запросов: *' + stats.queries.length + '*\n\n*Запросы:*\n' + list + '\n\n_Переходы — Яндекс.Метрика, utm\\_campaign=tg\\_bot\\_ai_';
  await bot.telegram.sendMessage(adminId, report.length > 4000 ? report.substring(0, 3900) + '\n...' : report, { parse_mode: 'Markdown' });
  stats.resetDaily();
}, { timezone: 'Europe/Moscow' });

// Старт
loadCache().then(() => { bot.launch(); console.log('GdeBar бот запущен'); });
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
