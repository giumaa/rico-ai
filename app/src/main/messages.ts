// User-facing error strings that main has to produce itself (the renderer only receives `message: string`).
// Arabic is written in the Libyan voice of the UI (not Fusha); English when the UI language is English.
// Technical `{detail}` text (file names, OS errors) is the only thing that may stay in English.

import type { UiLang } from '../shared/api';

const M = {
  noModel: {
    ar: 'ما عندكش نموذج منزّل توا. نزّل واحد من شاشة النماذج الأول.',
    en: 'No model is installed yet. Download one from the Models screen first.'
  },
  loading: {
    ar: 'النموذج توا يتحمّل، عاود بعد لحظات.',
    en: 'The model is still loading. Please try again in a moment.'
  },
  modelLoadFailed: {
    ar: 'ما قدرناش نحمّلو النموذج: {detail}',
    en: 'Could not load the model: {detail}'
  },
  outOfMemory: {
    ar: 'ذاكرة الجهاز ما تكفيش للنموذج هذا. جرّب نموذج أصغر ولا سكّر شوية برامج.',
    en: 'Not enough memory for this model. Try a smaller model or close some apps.'
  },
  badModelFile: {
    ar: 'الملف هذا موش نموذج GGUF صالح.',
    en: 'This is not a valid GGUF model file.'
  },
  missingShards: {
    ar: 'النموذج مقسوم على كذا ملف، وفيه ملفات ناقصة جنب الملف اللي اخترتو: {detail}',
    en: 'This model is split into several files and some are missing next to the selected file: {detail}'
  },
  engineCrashed: {
    ar: 'محرّك الذكاء الاصطناعي وقف فجأة. عاود جرّب.',
    en: 'The AI engine stopped unexpectedly. Please try again.'
  },
  engineBlocked: {
    ar: 'ويندوز (Smart App Control) منع محرّك الصور متاع ريكو. الكتابة تخدم عادي. إذا تبي الصور، طفّي Smart App Control من «أمن Windows» ولا استنّى النسخة الموقّعة.',
    en: 'Windows Smart App Control blocked Rico’s image engine. Text chat still works. To use images, turn off Smart App Control in Windows Security, or wait for a signed release.'
  },
  busy: {
    ar: 'ريكو مشغول بطلب ثاني.',
    en: 'Rico is busy with another request.'
  },
  generateFailed: {
    ar: 'صار خطأ وقت نكتبو الرد: {detail}',
    en: 'Something went wrong while generating the reply: {detail}'
  },
  unknownModel: {
    ar: 'نموذج موش معروف.',
    en: 'Unknown model.'
  },
  alreadyDownloading: {
    ar: 'النموذج هذا يتنزّل توا.',
    en: 'This model is already downloading.'
  },
  notInstalled: {
    ar: 'النموذج هذا موش منزّل.',
    en: 'This model is not installed.'
  },
  notEnoughDisk: {
    ar: 'المساحة على القرص ما تكفيش. نحتاجو تقريباً {detail} غيغا.',
    en: 'Not enough free disk space. About {detail} GB are needed.'
  },
  downloadOffline: {
    ar: 'ما نقدروش نوصلو للإنترنت. شوف الاتصال وعاود، ولا استورد ملف النموذج بيدك.',
    en: 'Could not reach the internet. Check your connection and try again, or import the model file manually.'
  },
  downloadFailed: {
    ar: 'فشل تنزيل النموذج: {detail}',
    en: 'Model download failed: {detail}'
  },
  checksumFailed: {
    ar: 'الملف اللي نزل خربان (البصمة موش مطابقة). عاود التنزيل.',
    en: 'The downloaded file is corrupted (checksum mismatch). Please download again.'
  },
  noVision: {
    ar: 'النموذج الحالي ما يقراش الصور. اختار نموذج يدعم الصور من شاشة النماذج.',
    en: 'The current model cannot read images. Pick a vision-capable model on the Models screen.'
  },
  noVisionBlocked: {
    ar: 'الصور ما تخدمش توا لأن ويندوز (Smart App Control) منع محرّك الصور. الكتابة تخدم عادي. طفّي Smart App Control من «أمن Windows» ولا استنّى النسخة الموقّعة.',
    en: 'Images do not work because Windows Smart App Control blocked the image engine. Text chat still works. Turn off Smart App Control in Windows Security, or wait for a signed release.'
  },
  noVisionUnavailable: {
    ar: 'محرّك الصور موش موجود في النسخة هذي، والنص يخدم عادي.',
    en: 'The image engine is not included in this build; text chat works normally.'
  },
  noVisionFailed: {
    ar: 'محرّك الصور ما قدرش يشتغل على الجهاز هذا، والنص يخدم عادي.',
    en: 'The image engine could not start on this computer; text chat works normally.'
  },
  noVisionProjector: {
    ar: 'ما قدرناش نحمّلو ملف قراءة الصور (mmproj) للنموذج هذا. جرّب تعاود تنزّل النموذج.',
    en: 'The image projector (mmproj) of this model could not be loaded. Try downloading the model again.'
  },
  tooManyImages: {
    ar: 'الجهاز هذا يقدر يقرا {detail} صور بس في الرسالة الواحدة. ابعثهم على دفعات.',
    en: 'This computer can read at most {detail} images per message. Send them in batches.'
  },
  pickedMmproj: {
    ar: 'الملف هذا هو مُسقِط الصور (mmproj) موش النموذج نفسه. اختار ملف النموذج الأساسي.',
    en: 'This is a vision projector (mmproj) file, not the model itself. Pick the main model file.'
  }
} as const;

export type MsgKey = keyof typeof M;

export function msg(key: MsgKey, lang: UiLang, detail?: string): string {
  const text: string = M[key][lang] ?? M[key].en;
  return text.replace('{detail}', detail ?? '');
}

/** Why a projector-equipped model cannot read images right now (see LoadedInfo.visionNote). */
export function noVisionKey(note: string | undefined): MsgKey {
  switch (note) {
    case 'blocked':
      return 'noVisionBlocked';
    case 'unavailable':
      return 'noVisionUnavailable';
    case 'failed':
      return 'noVisionFailed';
    case 'projector':
      return 'noVisionProjector';
    default:
      return 'noVision';
  }
}

/** Error carrying a localised message plus a stable machine-readable code. */
export class RicoError extends Error {
  constructor(
    readonly code: MsgKey,
    lang: UiLang,
    detail?: string
  ) {
    super(msg(code, lang, detail));
    this.name = 'RicoError';
  }
}
