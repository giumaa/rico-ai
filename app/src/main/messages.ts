// User-facing error strings that main has to produce itself (the renderer only receives `message: string`).
// Arabic first, English when the UI language is English.

import type { UiLang } from '../shared/api';

const M = {
  noModel: {
    ar: 'لا يوجد نموذج مثبّت. نزّل نموذجًا من شاشة النماذج أولًا.',
    en: 'No model is installed yet. Download one from the Models screen first.'
  },
  modelNotReady: {
    ar: 'النموذج ما زال قيد التحميل، حاول بعد لحظات.',
    en: 'The model is still loading. Try again in a moment.'
  },
  modelLoadFailed: {
    ar: 'تعذّر تحميل النموذج: {detail}',
    en: 'Could not load the model: {detail}'
  },
  outOfMemory: {
    ar: 'ذاكرة الجهاز لا تكفي لهذا النموذج. جرّب نموذجًا أصغر أو أغلق بعض البرامج.',
    en: 'Not enough memory for this model. Try a smaller model or close some apps.'
  },
  badModelFile: {
    ar: 'هذا الملف ليس نموذج GGUF صالحًا.',
    en: 'This is not a valid GGUF model file.'
  },
  missingShards: {
    ar: 'النموذج مقسّم إلى عدة ملفات وبعضها مفقود بجانب الملف المختار: {detail}',
    en: 'This model is split into several files and some are missing next to the selected file: {detail}'
  },
  engineCrashed: {
    ar: 'توقّف محرّك الذكاء الاصطناعي بشكل غير متوقع. أعد المحاولة.',
    en: 'The AI engine stopped unexpectedly. Please try again.'
  },
  busy: {
    ar: 'ريكو مشغول بطلب آخر.',
    en: 'Rico is busy with another request.'
  },
  generateFailed: {
    ar: 'حدث خطأ أثناء توليد الرد: {detail}',
    en: 'Something went wrong while generating the reply: {detail}'
  },
  unknownModel: {
    ar: 'نموذج غير معروف.',
    en: 'Unknown model.'
  },
  alreadyDownloading: {
    ar: 'هذا النموذج قيد التحميل بالفعل.',
    en: 'This model is already downloading.'
  },
  notInstalled: {
    ar: 'هذا النموذج غير مثبّت.',
    en: 'This model is not installed.'
  },
  notEnoughDisk: {
    ar: 'لا توجد مساحة كافية على القرص. المطلوب حوالي {detail} غيغابايت.',
    en: 'Not enough free disk space. About {detail} GB are needed.'
  },
  downloadOffline: {
    ar: 'تعذّر الاتصال بالإنترنت. تحقّق من الاتصال ثم أعد المحاولة، أو استورد ملف النموذج يدويًا.',
    en: 'Could not reach the internet. Check your connection and try again, or import the model file manually.'
  },
  downloadFailed: {
    ar: 'فشل تحميل النموذج: {detail}',
    en: 'Model download failed: {detail}'
  },
  noVision: {
    ar: 'النموذج الحالي لا يستطيع قراءة الصور. {detail}',
    en: 'The current model cannot read images. {detail}'
  },
  pickedMmproj: {
    ar: 'هذا ملف مُسقِط الصور (mmproj) وليس النموذج نفسه. اختر ملف النموذج الرئيسي.',
    en: 'This is a vision projector (mmproj) file, not the model itself. Pick the main model file.'
  },
  checksumFailed: {
    ar: 'الملف الذي تم تحميله تالف (فشل التحقق من البصمة). أعد التحميل.',
    en: 'The downloaded file is corrupted (checksum mismatch). Please download again.'
  }
} as const;

export type MsgKey = keyof typeof M;

export function msg(key: MsgKey, lang: UiLang, detail?: string): string {
  const text: string = M[key][lang] ?? M[key].en;
  return text.replace('{detail}', detail ?? '');
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
