// Development-only stand-in for the Electron preload bridge, so the renderer can be built and
// previewed in a plain browser (`vite` without Electron). It is installed by main.tsx ONLY when
// `window.rico` is undefined — inside Electron this file is never executed.
//
// URL flags (browser preview):
//   ?fresh=1       wipe the mock storage (back to the first-run onboarding)
//   ?installed=1   pretend the "rico-lite" model is already installed and active
//   ?speed=4       make simulated downloads faster
import type {
  Chat,
  ChatSummary,
  DoneEvent,
  DownloadProgress,
  ErrorEvent,
  GenerateRequest,
  ModelEntry,
  ModelLoadState,
  RicoAPI,
  Settings,
  SystemInfo,
  TokenEvent,
} from '@shared/api';

const LS = {
  chats: 'rico.mock.chats',
  settings: 'rico.mock.settings',
  models: 'rico.mock.models',
};

const GB = 1024 ** 3;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
const SYSTEM: SystemInfo = {
  platform: 'win32',
  arch: 'x64',
  totalRamGB: 15.8,
  freeRamGB: 8.4,
  cpuModel: 'Intel(R) Core(TM) i7-1165G7 @ 2.80GHz',
  physicalCores: 4,
  gpu: { type: 'vulkan', name: 'Intel Iris Xe Graphics', vramGB: 2 },
  recommendedModelId: 'rico',
  appVersion: '0.1.0-dev',
};

interface CatalogItem {
  id: string;
  name: { ar: string; en: string };
  description: { ar: string; en: string };
  sizeGB: number;
  minRamGB: number;
  contextLength: number;
}

const CATALOG: CatalogItem[] = [
  {
    id: 'rico-lite',
    name: { ar: 'ريكو لايت', en: 'Rico Lite' },
    description: {
      ar: 'خفيف وسريع، يخدم باهي على الأجهزة العادية. مناسب للأسئلة اليومية والكتابة القصيرة.',
      en: 'Light and fast, runs well on everyday laptops. Great for daily questions and short writing.',
    },
    sizeGB: 2.5,
    minRamGB: 8,
    contextLength: 8192,
  },
  {
    id: 'rico',
    name: { ar: 'ريكو', en: 'Rico' },
    description: {
      ar: 'التوازن الأحسن بين الجودة والسرعة. فاهم اللهجة الليبية أحسن ويكتب بأسلوب أدق.',
      en: 'The best balance of quality and speed. Understands Libyan dialect better and writes more precisely.',
    },
    sizeGB: 8.9,
    minRamGB: 16,
    contextLength: 16384,
  },
  {
    id: 'rico-max',
    name: { ar: 'ريكو ماكس', en: 'Rico Max' },
    description: {
      ar: 'أقوى نسخة: إجابات أعمق وأطول، للأجهزة القوية فقط.',
      en: 'The most capable version: deeper, longer answers — for powerful machines only.',
    },
    sizeGB: 18.6,
    minRamGB: 32,
    contextLength: 32768,
  },
];

interface ModelStore {
  installed: string[];
  active?: string;
  imported: CatalogItem[];
}

// ---------------------------------------------------------------------------
// canned replies (Libyan dialect for Arabic prompts, English for English prompts)
const REPLIES = {
  dinner: `بالصحة والهناء! هاني نقترحولك كم فكرة للعشاء اليوم، على حسب الوقت اللي عندك:

### أكلات سريعة (أقل من 30 دقيقة)
- **شكشوكة بالبيض**: طماطم وفلفل وبيض، وتتاكل بالخبز الطازج.
- **مقرونة بالصلصة** مع شوية جبنة مبشورة فوقها.
- **سندويشات تونة** على الطريقة الليبية: هريسة وزيتون وشوية ليمون.

### أكلات ياخذوا شوية وقت
1. **شربة ليبية**: ما يغلبها شي في الشتا، بالعظم والحمص والبقدونس.
2. **بازين** مع الصلصة واللحم، وخاصة لو عندك ضيوف.
3. **كسكسي بالخضرة**: خفيف ومشبّع في نفس الوقت.

> نصيحة: لو الجو بارد، الشربة مع خبز التنور أحسن اختيار.

قولي شن عندك في الدار ونعطيك وصفة بالمقادير؟`,

  solar: `الطاقة الشمسية فكرتها بسيطة: **الشمس تعطينا ضوء، والألواح تحوّلو لكهرباء**.

### كيف تخدم؟
1. **الألواح الشمسية** فيها خلايا من السيليكون، لما يطيح عليها ضوء الشمس تتحرك الإلكترونات وتولّد تيار كهربائي مستمر (DC).
2. **الإنفرتر** يحوّل التيار هذا لتيار متردد (AC) اللي تخدم بيه أجهزة الدار.
3. **البطاريات** (اختيارية) تخزّن الزيادة باش تستعملها بالليل أو وقت انقطاع الكهرباء.

### شن نحتاجو لبيت عادي؟
| المكوّن | الوظيفة | ملاحظة |
|---|---|---|
| ألواح شمسية | توليد الكهرباء | حسب استهلاكك |
| إنفرتر | تحويل DC إلى AC | اختار حسب القدرة |
| بطاريات | تخزين الطاقة | ليثيوم أحسن عمر |

وفي ليبيا الشمس متوفرة تقريباً طول السنة، وهذا يخلي الطاقة الشمسية خيار ممتاز. تبي نحسبولك كم لوح تحتاج؟`,

  letter: `أكيد، هاني كاتبلك رسالة رسمية قصيرة ومهذبة. بدّل المعلومات اللي بين الأقواس:

> السيد/ة [اسم المدير]، المحترم/ة
>
> تحية طيبة وبعد،
>
> أكتب لكم لأطلب [إجازة / تغيير موعد / ...] لمدة [المدة] ابتداءً من [التاريخ]، وذلك بسبب [السبب].
> أعد بإنجاز جميع مهامي قبل الغياب، وأنا جاهز للتنسيق مع الزملاء.
>
> وتفضلوا بقبول فائق الاحترام والتقدير،
> [اسمك]

تبي نخليها أقصر؟ أو بلهجة أخف لو الرسالة لزميل؟ قولي شن الموضوع بالضبط ونظبطها معاك.`,

  libya: `ليبيا فيها أماكن تهبل، وهذي أحسن اللي تستاهل الزيارة:

- **لبدة الكبرى** (الخمس): مدينة رومانية على البحر، من أحسن المواقع الأثرية في العالم.
- **صبراتة**: مسرحها الروماني الضخم مطل على المتوسط.
- **قورينا (شحات)**: آثار إغريقية في الجبل الأخضر وسط طبيعة خلابة.
- **غدامس**: "لؤلؤة الصحراء"، مدينة قديمة بيوتها بيضاء وأزقتها مسقوفة.
- **أكاكوس**: جبال في الجنوب فيها رسوم صخرية عمرها آلاف السنين.
- **بحر طرابلس والمدينة القديمة**: قهوة وسوق وجو ما يتعوّضش.

نصيحة: الربيع والخريف أحسن وقت للسفر، وفي الصحراء خذ ماء كافي وبلّش بدري.`,

  code: `هاك مثال بسيط بلغة Python يحسب مجموع الأرقام الزوجية في قائمة:

\`\`\`python
def sum_even(numbers):
    """يرجع مجموع الأرقام الزوجية فقط."""
    return sum(n for n in numbers if n % 2 == 0)

print(sum_even([1, 2, 3, 4, 5, 6]))  # 12
\`\`\`

الفكرة: نمرّو على كل رقم، ونشوفو لو **باقي القسمة على 2 يساوي صفر**، ونجمعو الأرقام اللي تحقق الشرط. تبي نشرحلك سطر سطر؟`,

  englishCode: `Here's a small Python example that sums the even numbers in a list:

\`\`\`python
def sum_even(numbers):
    """Return the sum of the even numbers only."""
    return sum(n for n in numbers if n % 2 == 0)

print(sum_even([1, 2, 3, 4, 5, 6]))  # 12
\`\`\`

The idea: walk through each number, keep it only when **n % 2 == 0**, and add the survivors up. Want a line-by-line walkthrough?`,

  englishDefault: `Happy to help! Here's a quick answer in English.

**Rico runs fully on your device**, so nothing you type ever leaves your computer. A few things I can do:

- Explain topics step by step
- Draft and polish messages or emails
- Translate between Arabic and English
- Brainstorm ideas

\`\`\`ts
// inline code and blocks are highlighted too
const greeting = (name: string) => \`Hello, \${name}!\`;
\`\`\`

What would you like to work on?`,

  arabicDefault: `أهلاً بيك! أنا **ريكو**، مساعدك اللي يخدم على جهازك بدون إنترنت.

نقدر نعاونك في:
- شرح أي موضوع بطريقة بسيطة
- كتابة رسائل وتلخيص نصوص
- الترجمة بين العربي والإنجليزي
- أفكار وتخطيط ونصايح يومية

قولي شن تبي، وإن شاء الله نلقاولك الحل. وإذا حبيت تحكي بالفصحى بس قولي.`,
};

function pickReply(prompt: string, imageCount = 0): string {
  if (imageCount > 0) {
    const arabic = /[؀-ۿ]/.test(prompt) || prompt.trim() === '';
    return arabic
      ? `شفت ${imageCount === 1 ? 'الصورة' : `${imageCount} صور`} اللي بعتها. هاني نوصفلك شن نشوف:

- **المشهد العام**: صورة واضحة وفيها ألوان دافية.
- **التفاصيل**: نقدر نقرا النصوص اللي فيها ونشرحلك أي حاجة تبيها.

قولي شن تبي بالضبط منها؟`
      : `I can see the ${imageCount === 1 ? 'image' : `${imageCount} images`} you sent. Here's what I notice:

- **Overall scene**: clear, with warm tones.
- **Details**: I can read any text in it and explain whatever you need.

What would you like to know about it?`;
  }
  const p = prompt.toLowerCase();
  if (/[؀-ۿ]/.test(prompt)) {
    if (/عشاء|نطيب|أكل|غداء/.test(prompt)) return REPLIES.dinner;
    if (/طاقة|شمس/.test(prompt)) return REPLIES.solar;
    if (/رسال|خدمت|عمل|مدير/.test(prompt)) return REPLIES.letter;
    if (/ليبيا|نزور|أماكن|سياح/.test(prompt)) return REPLIES.libya;
    if (/كود|برمج|بايثون/.test(prompt)) return REPLIES.code;
    return REPLIES.arabicDefault;
  }
  if (/code|python|function/.test(p)) return REPLIES.englishCode;
  return REPLIES.englishDefault;
}

// ---------------------------------------------------------------------------
export function installMockRico(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('fresh')) {
    Object.values(LS).forEach((k) => localStorage.removeItem(k));
  }
  const speedFactor = Number(params.get('speed') ?? 1) || 1;

  let settings: Settings = load<Settings>(LS.settings, {
    theme: 'system',
    uiLang: 'ar',
    perfMode: 'eco',
    temperature: 0.7,
    maxTokens: 1024,
    dialect: 'libyan',
    fontScale: 1,
  });

  let store = load<ModelStore>(LS.models, { installed: [], imported: [] });
  if (params.get('installed') && store.installed.length === 0) {
    store = { installed: ['rico-lite'], active: 'rico-lite', imported: [] };
    save(LS.models, store);
  }

  let chats = load<Record<string, Chat>>(LS.chats, {});
  let loadState: ModelLoadState = { state: 'idle' };
  const loadCbs = new Set<(s: ModelLoadState) => void>();
  const setLoad = (s: ModelLoadState) => {
    loadState = s;
    loadCbs.forEach((cb) => cb({ ...s }));
  };
  const downloading = new Map<string, { timer: number; cancelled: boolean }>();

  const progressCbs = new Set<(p: DownloadProgress) => void>();
  const tokenCbs = new Set<(e: TokenEvent) => void>();
  const doneCbs = new Set<(e: DoneEvent) => void>();
  const errorCbs = new Set<(e: ErrorEvent) => void>();
  const stopped = new Set<string>();

  const toEntry = (c: CatalogItem, source: 'catalog' | 'imported'): ModelEntry => {
    const installed = store.installed.includes(c.id) || source === 'imported';
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      sizeGB: c.sizeGB,
      minRamGB: c.minRamGB,
      contextLength: c.contextLength,
      status: downloading.has(c.id) ? 'downloading' : installed ? 'installed' : 'not-installed',
      isActive: store.active === c.id,
      source,
      supportsVision: !params.get('novision'),
    };
  };

  const emitProgress = (p: DownloadProgress) => progressCbs.forEach((cb) => cb(p));

  const api: RicoAPI = {
    system: {
      getInfo: async () => SYSTEM,
      getDataPath: async () => 'C:/Users/you/AppData/Roaming/Rico',
      openDataFolder: async () => undefined,
    },
    window: { setTitleBarTheme: async () => undefined },

    models: {
      list: async () => [
        ...CATALOG.map((c) => toEntry(c, 'catalog')),
        ...store.imported.map((c) => toEntry(c, 'imported')),
      ],

      download: async (modelId) => {
        const item = CATALOG.find((c) => c.id === modelId);
        if (!item || downloading.has(modelId)) return;
        const total = item.sizeGB * GB;
        let received = 0;
        const state = { timer: 0, cancelled: false };
        downloading.set(modelId, state);
        state.timer = window.setInterval(() => {
          const bps = (6 + Math.random() * 14) * 1024 ** 2 * speedFactor;
          received = Math.min(total, received + bps * 0.25);
          emitProgress({ modelId, receivedBytes: received, totalBytes: total, bytesPerSecond: bps, status: 'downloading' });
          if (received >= total) {
            window.clearInterval(state.timer);
            emitProgress({ modelId, receivedBytes: total, totalBytes: total, bytesPerSecond: 0, status: 'verifying' });
            window.setTimeout(() => {
              if (state.cancelled) return;
              downloading.delete(modelId);
              store.installed = [...new Set([...store.installed, modelId])];
              save(LS.models, store);
              emitProgress({ modelId, receivedBytes: total, totalBytes: total, bytesPerSecond: 0, status: 'done' });
            }, 1400);
          }
        }, 250);
      },

      cancelDownload: async (modelId) => {
        const d = downloading.get(modelId);
        if (!d) return;
        d.cancelled = true;
        window.clearInterval(d.timer);
        downloading.delete(modelId);
        emitProgress({ modelId, receivedBytes: 0, totalBytes: 0, bytesPerSecond: 0, status: 'cancelled' });
      },

      onProgress: (cb) => {
        progressCbs.add(cb);
        return () => progressCbs.delete(cb);
      },

      importFile: async () => {
        await sleep(500);
        const id = `imported-${rid()}`;
        const item: CatalogItem = {
          id,
          name: { ar: 'نموذج مستورد', en: 'Imported model' },
          description: { ar: 'ملف GGUF تم استيراده من جهازك.', en: 'A GGUF file imported from your device.' },
          sizeGB: 4.1,
          minRamGB: 8,
          contextLength: 8192,
        };
        store.imported = [...store.imported, item];
        save(LS.models, store);
        return toEntry(item, 'imported');
      },

      remove: async (modelId) => {
        store.installed = store.installed.filter((i) => i !== modelId);
        store.imported = store.imported.filter((i) => i.id !== modelId);
        if (store.active === modelId) {
          store.active = undefined;
          setLoad({ state: 'idle' });
        }
        save(LS.models, store);
      },

      setActive: async (modelId) => {
        store.active = modelId;
        save(LS.models, store);
        setLoad({ modelId, state: 'loading' });
        await sleep(1800);
        // ?visionoff=1 simulates the image engine being blocked (Windows Smart App Control): the model supports vision, the engine does not
        const visionOff = !!params.get('visionoff');
        setLoad({
          modelId,
          state: 'ready',
          vision: !visionOff && !params.get('novision'),
          engine: visionOff ? 'node-llama-cpp' : 'server',
          ...(visionOff
            ? { visionNote: 'ويندوز (Smart App Control) منع محرّك الصور متاع ريكو. الكتابة تخدم عادي.' }
            : {}),
        });
        settings = { ...settings, activeModelId: modelId };
        save(LS.settings, settings);
      },

      getLoadState: async () => ({ ...loadState }),
      onLoadState: (cb) => {
        loadCbs.add(cb);
        return () => loadCbs.delete(cb);
      },
    },

    chat: {
      generate: async (req: GenerateRequest) => {
        const requestId = rid();
        const last = [...req.messages].reverse().find((m) => m.role === 'user');
        const reply = pickReply(last?.content ?? '', last?.images?.length ?? 0);
        void (async () => {
          await sleep(500);
          const parts = reply.split(/(\s+)/).filter((s) => s.length > 0);
          let text = '';
          let i = 0;
          while (i < parts.length) {
            if (stopped.has(requestId)) {
              stopped.delete(requestId);
              doneCbs.forEach((cb) => cb({ requestId, text, stopped: true }));
              return;
            }
            const n = 1 + Math.floor(Math.random() * 3);
            const chunk = parts.slice(i, i + n).join('');
            i += n;
            text += chunk;
            tokenCbs.forEach((cb) => cb({ requestId, chunk }));
            await sleep((22 + Math.random() * 38) / Math.min(speedFactor, 3));
          }
          doneCbs.forEach((cb) => cb({ requestId, text, tokensPerSecond: 18.4 }));
        })();
        return { requestId };
      },
      stop: async (requestId) => {
        stopped.add(requestId);
      },
      onToken: (cb) => {
        tokenCbs.add(cb);
        return () => tokenCbs.delete(cb);
      },
      onDone: (cb) => {
        doneCbs.add(cb);
        return () => doneCbs.delete(cb);
      },
      onError: (cb) => {
        errorCbs.add(cb);
        return () => errorCbs.delete(cb);
      },
    },

    chats: {
      list: async (): Promise<ChatSummary[]> =>
        Object.values(chats)
          .map(({ id, title, updatedAt, pinned }) => ({ id, title, updatedAt, pinned }))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      get: async (id) => chats[id] ?? null,
      save: async (chat) => {
        chats = { ...chats, [chat.id]: chat };
        save(LS.chats, chats);
      },
      delete: async (id) => {
        const { [id]: _gone, ...rest } = chats;
        void _gone;
        chats = rest;
        save(LS.chats, chats);
      },
      deleteAll: async () => {
        chats = {};
        save(LS.chats, chats);
      },
    },

    settings: {
      get: async () => settings,
      set: async (patch) => {
        settings = { ...settings, ...patch };
        save(LS.settings, settings);
        return settings;
      },
    },
  };

  Object.defineProperty(window, 'rico', { value: api, writable: true, configurable: true });
}
