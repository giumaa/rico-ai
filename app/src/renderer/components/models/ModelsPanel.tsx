import { useEffect, useState } from 'react';
import { Upload, WifiOff } from 'lucide-react';
import type { ModelEntry } from '@shared/api';
import { useActions, useAppState } from '../../store/AppProvider';
import { useI18n } from '../../i18n/useI18n';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ModelCard } from './ModelCard';

interface ModelsPanelProps {
  /** onboarding shows the section headings and the offline note; settings is more compact */
  variant: 'onboarding' | 'settings';
}

/** Hardware summary + model tier cards + import. Shared by onboarding and Settings → Models. */
export function ModelsPanel({ variant }: ModelsPanelProps) {
  const { t, lang } = useI18n();
  const { models, modelsLoaded, downloads, system, loadState } = useAppState();
  const a = useActions();
  const [pendingRemove, setPendingRemove] = useState<ModelEntry | null>(null);

  useEffect(() => {
    void a.refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const catalog = models.filter((m) => m.source === 'catalog');
  // the biggest tier reads "…or more" in the RAM guidance line
  const topRam = Math.max(0, ...catalog.map((m) => m.minRamGB));
  const imported = models.filter((m) => m.source === 'imported');
  const activating = loadState.state === 'loading';

  const card = (m: ModelEntry) => (
    <ModelCard
      key={m.id}
      model={m}
      recommended={m.id === system?.recommendedModelId}
      download={downloads[m.id]}
      topTier={m.source === 'catalog' && m.minRamGB >= topRam}
      busyActivating={activating}
      onDownload={() => void a.downloadModel(m.id)}
      onCancel={() => void a.cancelDownload(m.id)}
      onActivate={() => void a.activateModel(m.id)}
      onRemove={() => setPendingRemove(m)}
    />
  );

  return (
    <div className="models-panel">
      <h2 className="onb-section-title">
        {t('onb.choose')} <small>{t('onb.chooseSub')}</small>
      </h2>
      {!modelsLoaded ? (
        <p className="net-note">{t('mdl.loadingList')}</p>
      ) : catalog.length === 0 && imported.length === 0 ? (
        <p className="net-note">{t('mdl.none')}</p>
      ) : (
        <div className="mdl-grid">{catalog.map(card)}</div>
      )}

      {imported.length > 0 ? (
        <>
          <h2 className="onb-section-title onb-section-spaced">
            {t('mdl.importedSection')}
          </h2>
          <div className="mdl-grid">{imported.map(card)}</div>
        </>
      ) : null}

      <div className="import-row">
        <span className="import-ico">
          <Upload aria-hidden />
        </span>
        <div className="import-text">
          <b>{t('onb.import')}</b>
          <span>{t('onb.importHint')}</span>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => void a.importModel()}>
          {t('onb.importBtn')}
        </button>
      </div>

      {variant === 'onboarding' ? (
        <p className="net-note">
          <WifiOff aria-hidden />
          {t('onb.netNote')}
        </p>
      ) : null}

      {pendingRemove ? (
        <ConfirmDialog
          title={t('mdl.confirmRemoveTitle')}
          body={t('mdl.confirmRemoveBody', { name: pendingRemove.name[lang] })}
          confirmLabel={t('mdl.remove')}
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            void a.removeModel(pendingRemove.id);
            setPendingRemove(null);
          }}
        />
      ) : null}
    </div>
  );
}
