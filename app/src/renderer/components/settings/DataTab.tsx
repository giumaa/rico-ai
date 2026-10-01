import { useEffect, useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { useActions, useAppState } from '../../store/AppProvider';
import { useI18n } from '../../i18n/useI18n';
import { ConfirmDialog } from '../ui/ConfirmDialog';

export function DataTab() {
  const { t } = useI18n();
  const { chatIndex } = useAppState();
  const a = useActions();
  const [confirm, setConfirm] = useState(false);
  const [dataPath, setDataPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.rico.system
      .getDataPath()
      .then((p) => alive && setDataPath(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="set-group">
      <h3 className="set-group-title">{t('settings.data.title')}</h3>
      <p className="set-desc set-desc-wide">{t('settings.data.desc')}</p>

      {dataPath ? (
        <div className="data-path">
          <div>
            <div className="set-label">{t('settings.data.path')}</div>
            <code className="data-path-value" dir="ltr">
              {dataPath}
            </code>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void window.rico.system.openDataFolder()}>
            <FolderOpen aria-hidden />
            {t('settings.data.open')}
          </button>
        </div>
      ) : null}

      <div className="danger-zone">
        <div className="danger-row">
          <div>
            <div className="set-label">{t('settings.data.deleteAll')}</div>
            <div className="set-desc">{t('settings.data.deleteAll.desc')}</div>
          </div>
          <button type="button" className="btn btn-danger" disabled={chatIndex.length === 0} onClick={() => setConfirm(true)}>
            <Trash2 aria-hidden />
            {t('common.delete')}
          </button>
        </div>
      </div>
      {confirm ? (
        <ConfirmDialog
          title={t('settings.data.deleteAll.title')}
          body={t('settings.data.deleteAll.body')}
          confirmLabel={t('settings.data.deleteAll.confirm')}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void a.deleteAllChats();
          }}
        />
      ) : null}
    </section>
  );
}
