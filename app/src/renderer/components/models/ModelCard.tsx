import { CircleCheck, Download, Eye, LoaderCircle, MemoryStick, Power, RefreshCw, Trash2, X } from 'lucide-react';
import type { ModelEntry } from '@shared/api';
import type { DownloadView } from '../../store/types';
import { useI18n } from '../../i18n/useI18n';
import { formatBytes, formatEta, formatGB, formatSpeed } from '../../lib/format';

interface ModelCardProps {
  model: ModelEntry;
  recommended: boolean;
  download?: DownloadView;
  /** the largest catalog tier: its RAM line reads "…or more" */
  topTier: boolean;
  busyActivating: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onActivate: () => void;
  onRemove: () => void;
}

export function ModelCard({
  model,
  recommended,
  download,
  topTier,
  busyActivating,
  onDownload,
  onCancel,
  onActivate,
  onRemove,
}: ModelCardProps) {
  const { t, lang } = useI18n();

  const dlStatus = download?.status;
  const verifying = dlStatus === 'verifying';
  const downloading = dlStatus === 'downloading' || (!download && model.status === 'downloading');
  const failed = dlStatus === 'error' || (!download && model.status === 'error');
  const installed = model.status === 'installed' && !downloading && !verifying;

  const total = download?.totalBytes || model.sizeGB * 1024 ** 3;
  const received = download?.receivedBytes ?? 0;
  const known = (download?.totalBytes ?? 0) > 0;
  const pct = known ? Math.min(100, (received / total) * 100) : Math.round((model.progress ?? 0) * 100);
  const indeterminate = downloading && !known && !model.progress;
  const eta = download ? formatEta(total - received, download.smoothBps) : null;

  return (
    <article
      className="mdl"
      data-recommended={recommended && !installed}
      data-active={model.isActive}
      aria-label={model.name[lang]}
    >
      <div className="mdl-badges">
        {recommended ? <span className="badge badge-accent">★ {t('mdl.recommended')}</span> : null}
        {model.isActive ? (
          <span className="badge badge-green">
            <CircleCheck aria-hidden />
            {t('mdl.active')}
          </span>
        ) : installed ? (
          <span className="badge badge-green">{t('mdl.installed')}</span>
        ) : null}
        {model.source === 'imported' ? <span className="badge">{t('mdl.imported')}</span> : null}
      </div>

      <h3 className="mdl-name" dir="auto">
        {model.name[lang]}
      </h3>
      <p className="mdl-desc" dir="auto">
        {model.description[lang]}
      </p>

      {model.source === 'catalog' && model.minRamGB > 0 ? (
        <p className="mdl-ram" dir="auto">
          <MemoryStick aria-hidden />
          <span>{t(topTier ? 'mdl.ramGuideMore' : 'mdl.ramGuide', { gb: formatGB(model.minRamGB) })}</span>
        </p>
      ) : null}

      <div className="mdl-stats">
        <span className="badge">{t('mdl.size', { gb: formatGB(model.sizeGB) })}</span>
        {model.supportsVision ? (
          <span className="badge badge-green">
            <Eye aria-hidden />
            {t('mdl.vision')}
          </span>
        ) : null}
      </div>

      {downloading ? (
        <div className="dl" aria-live="off">
          <div className={indeterminate ? 'progress progress-indeterminate' : 'progress'}>
            <div
              className="progress-fill"
              style={indeterminate ? undefined : { width: `${pct}%` }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={indeterminate ? undefined : Math.round(pct)}
              aria-label={t('mdl.downloading')}
            />
          </div>
          <div className="dl-row">
            <span className="dl-pct">
              <b>{indeterminate ? '…' : `${pct.toFixed(pct >= 10 ? 0 : 1)}%`}</b>
              {known ? ` · ${t('mdl.of', { received: formatBytes(received), total: formatBytes(total) })}` : null}
            </span>
          </div>
          <div className="dl-row">
            <span>
              {t('mdl.speed')}: <bdi dir="ltr"><b>{formatSpeed(download?.smoothBps ?? 0)}</b></bdi>
            </span>
            <span>
              {t('mdl.eta')}: <bdi dir="ltr"><b>{eta ?? '—'}</b></bdi>
            </span>
          </div>
        </div>
      ) : null}

      {verifying ? (
        <p className="dl-verify" role="status">
          <LoaderCircle className="spin" aria-hidden />
          {t('mdl.verifying')}
        </p>
      ) : null}

      {failed ? <p className="dl-error">{download?.error || model.error || t('error.generic')}</p> : null}

      <div className="mdl-actions">
        {downloading ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            <X aria-hidden />
            {t('mdl.cancel')}
          </button>
        ) : verifying ? null : installed ? (
          <>
            {!model.isActive ? (
              <button
                type="button"
                className={recommended ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                onClick={onActivate}
                disabled={busyActivating}
              >
                {busyActivating ? <LoaderCircle className="spin" aria-hidden /> : <Power aria-hidden />}
                {t('mdl.activate')}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove} aria-label={`${t('mdl.remove')} ${model.name[lang]}`}>
              <Trash2 aria-hidden />
              {t('mdl.remove')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={recommended ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={onDownload}
          >
            {failed ? <RefreshCw aria-hidden /> : <Download aria-hidden />}
            {failed ? t('mdl.retry') : t('mdl.download')}
          </button>
        )}
      </div>
    </article>
  );
}
